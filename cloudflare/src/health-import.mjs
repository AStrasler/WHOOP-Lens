// Web file import for Health Connect v2 JSON. Not a phone sync and not an
// Android companion. Ownership comes only from the verified caller.
import {parseLocalImport} from '../../docs/web-import.mjs';
import {activeMembership} from './storage.mjs';

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

export async function importHealthConnectFile(db,userId,file,consent,{now=Date.now()}={}){
  const id=await requireMember(db,userId);
  if(consent!==IMPORT_CONSENT)throw Error('Consent required');
  const text=typeof file==='string'?file:JSON.stringify(file);
  const parsed=parseLocalImport(text,now);
  if(parsed.kind!=='health_connect_preview')
    throw Error('Only a Health Connect v2 file can be stored. FHIR bundles stay a local preview.');
  const granted=new Date(now).toISOString();
  const consentWrite=await db.prepare(
    'INSERT INTO health_import_consent(user_id,purpose,granted_at,withdrawn_at) VALUES(?1,?2,?3,NULL) '+
    'ON CONFLICT(user_id) DO UPDATE SET purpose=excluded.purpose,granted_at=excluded.granted_at,withdrawn_at=NULL'
  ).bind(id,'health_connect_file',granted).run();
  if(!consentWrite?.success)throw Error('Import unavailable');
  let stored=0;
  for(const row of parsed.records){
    const saved=await db.prepare(
      'INSERT INTO health_connect_records(id,user_id,metric,record_key,origin_package,observed_at,ended_at,local_date,unit,payload_json) '+
      'VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) '+
      'ON CONFLICT(user_id,metric,record_key) DO UPDATE SET origin_package=excluded.origin_package,'+
      'observed_at=excluded.observed_at,ended_at=excluded.ended_at,local_date=excluded.local_date,'+
      'unit=excluded.unit,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP'
    ).bind(recordId(),id,row.metric,row.record_key,row.origin_package,row.observed_at,row.ended_at,
      row.local_date,row.unit,JSON.stringify(row.payload)).run();
    if(!saved?.success||saved.meta?.changes!==1)throw Error('Import unavailable');
    stored++;
  }
  return {stored,source:'health_connect',transport:'web_file_import',consent:'granted'};
}

export async function withdrawHealthConnectImport(db,userId,consent){
  const id=await requireMember(db,userId);
  if(consent!==WITHDRAW_CONSENT)throw Error('Consent required');
  const removed=await db.prepare('DELETE FROM health_connect_records WHERE user_id=?1').bind(id).run();
  if(!removed?.success)throw Error('Import unavailable');
  const marked=await db.prepare(
    'UPDATE health_import_consent SET withdrawn_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND purpose=?2'
  ).bind(id,'health_connect_file').run();
  if(!marked?.success)throw Error('Import unavailable');
  return {deleted:removed.meta?.changes??0,consent:'withdrawn',source:'health_connect'};
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
  const text=await request.text();
  if(text.length>limit)throw Error('Choose a JSON file no larger than 500 KB.');
  try{return JSON.parse(text);}catch{throw Error('This file is not valid JSON.');}
}
export async function healthConnectHttp(request,env,userId){
  const url=new URL(request.url);
  try{
    if(request.method==='GET'&&url.pathname==='/v1/health-connect/status')
      return httpJson(await healthConnectStatus(env.DB,userId));
    if(request.method==='DELETE'&&url.pathname==='/v1/health-connect'){
      const body=await readJson(request,4096);
      return httpJson(await withdrawHealthConnectImport(env.DB,userId,body?.consent));
    }
    if(request.method==='POST'&&url.pathname==='/v1/health-connect/import'){
      const body=await readJson(request,512000);
      return httpJson(await importHealthConnectFile(env.DB,userId,body?.file,body?.consent));
    }
    return httpJson({error:'Not found'},request.method==='GET'||request.method==='POST'||request.method==='DELETE'?404:405);
  }catch(error){
    const safe=publicImportError(error);
    if(safe)return httpJson({error:safe},400);
    if(error instanceof Error&&error.message==='Not authorized')return httpJson({error:'Not authorized'},403);
    return httpJson({error:'Health Connect import unavailable'},503);
  }
}
