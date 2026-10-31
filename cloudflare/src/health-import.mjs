import {readBounded} from './bounded-body.mjs';
// Web file import for Health Connect v2 JSON. Not a phone sync and not an
// Android companion. Ownership comes only from the verified caller.
import {parseLocalImport} from '../../docs/web-import.mjs';
import {healthImportAdmission,advanceHealthFence,HEALTH_WRITE_SQL} from './health-consent-fence.mjs';
import {ACTIVE_MEMBER_SQL,activeMembership} from './storage.mjs';

export const IMPORT_CONSENT='store-health-connect-file';
export const WITHDRAW_CONSENT='delete-my-health-connect-records';
const SAFE=/^(Consent required|Choose a JSON file|This file is not valid JSON|Expected a |Invalid measurement|Invalid exercise|Invalid originating|Only a Health Connect|An end time|One of the local|Duplicate |Unsupported unit|A date is missing)/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userIdOf(userId){
  if(typeof userId!=='string'||!UUID.test(userId))throw Error('Invalid verified user');
  return userId.toLowerCase();
}
async function requireMember(db,userId){
  const id=userIdOf(userId);
  if(!await activeMembership(db,id))throw Error('Not authorized');
  return id;
}
export function publicImportError(error){
  const message=error instanceof Error?error.message:'';
  return SAFE.test(message)?message:null;
}
function recordId(){return crypto.randomUUID();}

export async function importHealthConnectFile(db,userId,file,consent,{now=Date.now(),generation}={}){
  const id=await requireMember(db,userId);
  if(consent!==IMPORT_CONSENT)throw Error('Consent required');
  const text=typeof file==='string'?file:JSON.stringify(file);
  const parsed=parseLocalImport(text,now);
  if(parsed.kind!=='health_connect_preview')
    throw Error('Only a Health Connect v2 file can be stored. FHIR bundles stay a local preview.');
  const epoch=generation??await healthImportAdmission(db,id);
  const granted=new Date(now).toISOString();
  // One D1 batch (single transaction): consent and every row land together,
  // or nothing does. A mid-file failure must not leave a partial import.
  const statements=[db.prepare(
    'INSERT INTO health_import_consent(user_id,purpose,granted_at,withdrawn_at) SELECT ?1,?2,?3,NULL WHERE '+HEALTH_WRITE_SQL+' '+
    'ON CONFLICT(user_id) DO UPDATE SET purpose=excluded.purpose,granted_at=excluded.granted_at,withdrawn_at=NULL'
  ).bind(id,'health_connect_file',granted,epoch)];
  for(const row of parsed.records){
    statements.push(db.prepare(
      'INSERT INTO health_connect_records(id,user_id,metric,record_key,origin_package,observed_at,ended_at,local_date,unit,payload_json) '+
      'SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS ('+ACTIVE_MEMBER_SQL.replaceAll('?1','?2')+') AND EXISTS (SELECT 1 FROM health_import_fences WHERE user_id=?2 AND generation=?11) '+
      'ON CONFLICT(user_id,metric,record_key) DO UPDATE SET origin_package=excluded.origin_package,'+
      'observed_at=excluded.observed_at,ended_at=excluded.ended_at,local_date=excluded.local_date,'+
      'unit=excluded.unit,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP'
    ).bind(recordId(),id,row.metric,row.record_key,row.origin_package,row.observed_at,row.ended_at,
      row.local_date,row.unit,JSON.stringify(row.payload),epoch));
  }
  let results;
  try{results=await db.batch(statements);}catch{throw Error('Import unavailable');}
  if(!Array.isArray(results)||results.length!==statements.length||
     results.some(r=>!r?.success||r.meta?.changes!==1))
    throw Error('Import unavailable');
  const stored=results.length-1;
  return {stored,source:'health_connect',transport:'web_file_import',consent:'granted'};
}

export async function withdrawHealthConnectImport(db,userId,consent){
  const id=await requireMember(db,userId);
  if(consent!==WITHDRAW_CONSENT)throw Error('Consent required');
  // Delete, withdrawal, and ingest-token revocation land together so a phone
  // token cannot keep writing after the member removes stored records.
  let results,hasTokenTable=false;
  try{
    const tokenTable=await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='health_connect_ingest_tokens'"
    ).first();
    hasTokenTable=!!tokenTable?.name;
    const statements=[
      db.prepare('DELETE FROM health_connect_records WHERE user_id=?1').bind(id),
      db.prepare('UPDATE health_import_consent SET withdrawn_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND purpose=?2')
        .bind(id,'health_connect_file')
    ];
    if(tokenTable?.name) statements.push(db.prepare(
      'UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND revoked_at IS NULL'
    ).bind(id));
    statements.push(advanceHealthFence(db,id));
    results=await db.batch(statements);
  }catch{throw Error('Import unavailable');}
  if(!Array.isArray(results)||results.some(r=>!r?.success))throw Error('Import unavailable');
  return {deleted:results[0].meta?.changes??0,consent:'withdrawn',source:'health_connect',
    ingest_tokens_revoked:hasTokenTable?(results[2]?.meta?.changes??0):0};
}

export async function healthConnectStatus(db,userId){
  const id=await requireMember(db,userId);
  const count=await db.prepare('SELECT COUNT(*) AS n FROM health_connect_records WHERE user_id=?1').bind(id).first();
  const consent=await db.prepare(
    'SELECT granted_at,withdrawn_at FROM health_import_consent WHERE user_id=?1 AND purpose=?2'
  ).bind(id,'health_connect_file').first();
  let state='none';
  if(consent?.granted_at&&!consent.withdrawn_at)state='granted';
  else if(consent?.withdrawn_at)state='withdrawn';
  return {
    stored_records:Number(count?.n??0),
    consent:state,
    source:'health_connect',
    transport:'web_file_import',
    live_sync:false
  };
}

function httpJson(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'",
    'referrer-policy':'no-referrer'
  }});
}
async function readJson(request,limit){
  if(Number(request.headers.get('content-length'))>limit)
    throw Error('Choose a JSON file no larger than 500 KB.');
  const bounded=await readBounded(request,limit);
  if(bounded.error==='too_large')throw Error('Choose a JSON file no larger than 500 KB.');
  if(bounded.error)throw Error('This file is not valid JSON.');
  const text=bounded.text;
  try{return JSON.parse(text);}catch{throw Error('This file is not valid JSON.');}
}
export async function healthConnectHttp(request,env,userId){
  if(env?.WEB_HEALTH_IMPORT_ENABLED!=='true')return httpJson({error:'Health Connect import is not activated',code:'feature_disabled'},503);
  const url=new URL(request.url);
  try{
    if(request.method==='GET'&&url.pathname==='/v1/health-connect/status')
      return httpJson(await healthConnectStatus(env.DB,userId));
    if(request.method==='DELETE'&&url.pathname==='/v1/health-connect'){
      const body=await readJson(request,4096);
      return httpJson(await withdrawHealthConnectImport(env.DB,userId,body?.consent));
    }
    if(request.method==='POST'&&url.pathname==='/v1/health-connect/import'){
      const generation=await healthImportAdmission(env.DB,userId);
      const body=await readJson(request,512000);
      return httpJson(await importHealthConnectFile(env.DB,userId,body?.file,body?.consent,{generation}));
    }
    return httpJson({error:'Not found'},request.method==='GET'||request.method==='POST'||request.method==='DELETE'?404:405);
  }catch(error){
    const safe=publicImportError(error);
    if(safe)return httpJson({error:safe},400);
    if(error instanceof Error&&error.message==='Not authorized')return httpJson({error:'Not authorized'},403);
    return httpJson({error:'Health Connect import unavailable'},503);
  }
}
