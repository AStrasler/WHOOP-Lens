import {readBounded} from './bounded-body.mjs';
// HC Webhook (com.hcwebhook.app) JSON ingest. The phone authenticates with a
// per-user bearer. The owner is the token's member, never a field in the body.
import {activeMembership} from './storage.mjs';
import {ISSUE_GUIDANCE} from './member-guidance.mjs';

export const WEBHOOK_PATH='/api/health-connect/webhook';
export const ISSUE_CONSENT='enable-health-connect-webhook';
export const REVOKE_CONFIRM='revoke-health-connect-ingest-token';
const CONSENT_PURPOSE='health_connect_file';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE=/^hct_[A-Za-z0-9_-]{43}$/;
const HC_ID=/^[0-9a-zA-Z_.:-]{1,80}$/;
const PACKAGE=/^[a-zA-Z0-9_.]{1,160}$/;
const EXERCISE=/^[^\u0000-\u001f]{1,80}$/;
const WINDOW_MS=15*60*1000;
const DEFAULT_MAX_BODY=12*1024*1024;
const DEFAULT_MAX_HITS=40;
const DEFAULT_MAX_STORED=20000;
const CHUNK_CHARS=500000;
const STORED={
  steps:'steps_daily',
  sleep:'sleep_session',
  heart_rate:'heart_rate',
  exercise:'exercise_session'
};
const ENVELOPE=new Set(['timestamp','app_version']);
const enc=new TextEncoder();

function userIdOf(userId){
  if(typeof userId!=='string'||!UUID.test(userId))throw Error('Invalid verified user');
  return userId.toLowerCase();
}
async function requireMember(db,userId){
  const id=userIdOf(userId);
  if(!await activeMembership(db,id))throw Error('Not authorized');
  return id;
}
function base64Url(bytes){
  let raw='';
  for(const byte of bytes) raw+=String.fromCharCode(byte);
  return btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
async function sha256Hex(value){
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(value));
  let hex='';
  for(const byte of new Uint8Array(digest)) hex+=byte.toString(16).padStart(2,'0');
  return hex;
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
function fail(status,error){return httpJson({error},status);}
function instant(value){
  if(typeof value!=='string'||value.length>40)return null;
  const parts=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts||Number(parts[2])>23||Number(parts[3])>59||Number(parts[4])>59)return null;
  const calendar=Date.parse(parts[1]+'T00:00:00Z');
  if(!Number.isFinite(calendar)||new Date(calendar).toISOString().slice(0,10)!==parts[1])return null;
  const ms=Date.parse(value);
  if(!Number.isFinite(ms))return null;
  return new Date(ms).toISOString();
}
function integer(value,min,max){
  return typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max?value:null;
}
function finite(value,min,max){
  return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;
}
function originOf(record){
  const origin=record?.metadata?.data_origin;
  return typeof origin==='string'&&PACKAGE.test(origin)?origin:null;
}
function hcId(record){
  const candidates=[record?.metadata?.id,record?.id];
  for(const id of candidates) if(typeof id==='string'&&HC_ID.test(id)) return id;
  return null;
}
function lastModified(record){
  const meta=record?.metadata;
  if(!meta||typeof meta!=='object')return null;
  return instant(meta.lastModifiedTime)||instant(meta.last_modified_time);
}
function zoneOffset(record){
  const meta=record?.metadata;
  if(!meta||typeof meta!=='object')return null;
  for(const key of ['start_zone_offset_seconds','startZoneOffsetSeconds','zone_offset_seconds','instant_zone_offset_seconds']){
    const value=meta[key];
    if(Number.isInteger(value)&&value>=-18*3600&&value<=18*3600) return value;
  }
  return null;
}
function localDate(iso,record){
  const offset=zoneOffset(record);
  if(offset==null)return null;
  return new Date(Date.parse(iso)+offset*1000).toISOString().slice(0,10);
}
function withProvenance(fields,record){
  const body={...fields,ingest:'hc_webhook'};
  const modified=lastModified(record);
  if(modified) body.last_modified=modified;
  return body;
}
async function recordKey(metric,id,material){
  if(id) return 'hc:'+id;
  return 'k:'+await sha256Hex(metric+'\n'+material);
}
function stagesOf(record){
  if(!Array.isArray(record.stages)) return undefined;
  const stages=[];
  for(const stage of record.stages){
    if(stages.length>=64) break;
    if(!stage||typeof stage!=='object'||Array.isArray(stage)) continue;
    const name=stage.stage,start=instant(stage.start_time),end=instant(stage.end_time);
    const duration=integer(stage.duration_seconds,0,10_000_000);
    if(typeof name!=='string'||name.length<1||name.length>40||!start||!end||duration==null) continue;
    stages.push({stage:name,start_time:start,end_time:end,duration_seconds:duration});
  }
  return stages.length?stages:undefined;
}
async function mapRecord(type,record){
  if(!record||typeof record!=='object'||Array.isArray(record)) return null;
  const id=hcId(record);
  const origin=originOf(record);
  if(type==='steps'){
    const start=instant(record.start_time),end=instant(record.end_time),count=integer(record.count,0,10_000_000);
    if(!start||!end||Date.parse(end)<Date.parse(start)||count==null) return null;
    return row('steps_daily',await recordKey('steps',id,`${start}\n${end}\n${origin||''}`),origin,start,end,localDate(start,record),'steps',withProvenance({count},record));
  }
  if(type==='sleep'){
    const end=instant(record.session_end_time),duration=integer(record.duration_seconds,0,10_000_000);
    if(!end||duration==null) return null;
    const start=new Date(Date.parse(end)-duration*1000).toISOString();
    const fields={duration_seconds:duration};
    const stages=stagesOf(record);
    if(stages) fields.stages=stages;
    return row('sleep_session',await recordKey('sleep',id,`${end}\n${duration}\n${origin||''}`),origin,start,end,localDate(start,record),'seconds',withProvenance(fields,record));
  }
  if(type==='heart_rate'){
    const time=instant(record.time),bpm=finite(record.bpm,0,400);
    if(!time||bpm==null) return null;
    const fields={bpm};
    const min=finite(record.min,0,400),max=finite(record.max,0,400);
    if(min!=null) fields.min=min;
    if(max!=null) fields.max=max;
    return row('heart_rate',await recordKey('heart_rate',id,`${time}\n${origin||''}`),origin,time,null,localDate(time,record),'bpm',withProvenance(fields,record));
  }
  if(type==='exercise'){
    const start=instant(record.start_time),end=instant(record.end_time);
    const duration=integer(record.duration_seconds,0,10_000_000);
    if(!start||!end||Date.parse(end)<Date.parse(start)||duration==null) return null;
    if(typeof record.type!=='string'||!EXERCISE.test(record.type)) return null;
    return row('exercise_session',await recordKey('exercise',id,`${start}\n${end}\n${record.type}\n${origin||''}`),origin,start,end,localDate(start,record),'seconds',withProvenance({duration_seconds:duration,exercise_type:record.type},record));
  }
  return null;
}
function row(metric,record_key,origin,observed_at,ended_at,local_date,unit,payload){
  const payload_json=JSON.stringify(payload);
  if(payload_json.length>8000) return null;
  return {id:crypto.randomUUID(),metric,record_key,origin_package:origin,observed_at,ended_at,local_date,unit,payload_json};
}
export async function mapWebhookPayload(data,{maxStored=DEFAULT_MAX_STORED}={}){
  if(!data||typeof data!=='object'||Array.isArray(data)) return {error:'invalid'};
  if(!instant(data.timestamp)) return {error:'invalid'};
  if(typeof data.app_version!=='string'||data.app_version.length<1||data.app_version.length>40) return {error:'invalid'};
  const skipped_types={};
  let skipped=0,rejected=0;
  const mapped=[];
  for(const key of Object.keys(data)){
    if(ENVELOPE.has(key)) continue;
    const value=data[key];
    if(!Object.hasOwn(STORED,key)){
      skipped+=Array.isArray(value)?value.length:1;
      skipped_types[key]=Array.isArray(value)?value.length:1;
      continue;
    }
    if(!Array.isArray(value)){rejected++;continue;}
    if(value.length>maxStored) return {error:'too_large'};
    for(const item of value){
      const record=await mapRecord(key,item);
      if(!record) rejected++;
      else mapped.push(record);
    }
  }
  const byKey=new Map();
  for(const record of mapped){
    const key=record.metric+'\n'+record.record_key,previous=byKey.get(key);
    const incoming=JSON.parse(record.payload_json).last_modified;
    const existing=previous&&JSON.parse(previous.payload_json).last_modified;
    // Match the database version rule, including legacy unversioned uploads.
    if(!existing||(incoming&&incoming>=existing))byKey.set(key,record);
  }
  const rows=[...byKey.values()];
  if(rows.length>maxStored) return {error:'too_large'};
  return {rows,skipped,skipped_types,rejected};
}
function chunkRows(rows){
  const batches=[];
  let current=[],size=2;
  for(const record of rows){
    const encoded=JSON.stringify(record);
    if(current.length&&size+encoded.length+1>CHUNK_CHARS){
      batches.push(current);
      current=[];
      size=2;
    }
    current.push(record);
    size+=encoded.length+1;
  }
  if(current.length) batches.push(current);
  return batches;
}
// Rechecked inside the write transaction, after reading/validating the body.
// A revoked token cannot become valid again, even when consent is re-granted.
const WRITE_AUTH=`EXISTS (
  SELECT 1 FROM health_connect_ingest_tokens t
  JOIN health_import_consent c ON c.user_id=t.user_id
  JOIN whoop_members m ON m.user_id=t.user_id
  JOIN identity_links i ON i.user_id=t.user_id
  WHERE t.user_id=?1 AND t.token_hash=?3 AND t.revoked_at IS NULL
    AND c.purpose='health_connect_file' AND c.granted_at IS NOT NULL AND c.withdrawn_at IS NULL
    AND m.active=1 AND (i.identity_provider='cloudflare_access' AND length(i.provider_subject)>0)
)`;
const UPSERT=
  'INSERT INTO health_connect_records(id,user_id,metric,record_key,origin_package,observed_at,ended_at,local_date,unit,payload_json) '+
  'SELECT json_extract(j.value,\'$.id\'),?1,json_extract(j.value,\'$.metric\'),json_extract(j.value,\'$.record_key\'),'+
  'json_extract(j.value,\'$.origin_package\'),json_extract(j.value,\'$.observed_at\'),json_extract(j.value,\'$.ended_at\'),'+
  'json_extract(j.value,\'$.local_date\'),json_extract(j.value,\'$.unit\'),json_extract(j.value,\'$.payload_json\') '+
  'FROM json_each(?2) AS j WHERE '+WRITE_AUTH+' '+ // WHERE ends the FROM so ON CONFLICT is the upsert, not a join.
  'ON CONFLICT(user_id,metric,record_key) DO UPDATE SET origin_package=excluded.origin_package,'+
  'observed_at=excluded.observed_at,ended_at=excluded.ended_at,local_date=excluded.local_date,'+
  'unit=excluded.unit,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP '+
  'WHERE json_extract(health_connect_records.payload_json,\'$.last_modified\') IS NULL '+
  'OR json_extract(excluded.payload_json,\'$.last_modified\')>=json_extract(health_connect_records.payload_json,\'$.last_modified\')';

async function consumeRate(db,hash,now,maxHits){
  const nowIso=new Date(now).toISOString();
  const cutoff=new Date(now-WINDOW_MS).toISOString();
  const result=await db.prepare(
    'UPDATE health_connect_ingest_tokens SET '+
    'window_hits=CASE WHEN window_started_at IS NULL OR window_started_at<=?1 THEN 1 ELSE window_hits+1 END, '+
    'window_started_at=CASE WHEN window_started_at IS NULL OR window_started_at<=?1 THEN ?2 ELSE window_started_at END '+
    'WHERE token_hash=?3 AND revoked_at IS NULL AND (window_started_at IS NULL OR window_started_at<=?1 OR window_hits<?4)'
  ).bind(cutoff,nowIso,hash,maxHits).run();
  return result?.success&&result.meta?.changes===1;
}

function bearer(request){
  const header=request.headers.get('authorization')||'';
  if(header.length>200) return null;
  const match=/^Bearer\s+(\S+)$/i.exec(header);
  if(!match||!TOKEN_RE.test(match[1])) return null;
  return match[1];
}
export async function issueIngestToken(db,userId,consent){
  const id=await requireMember(db,userId);
  if(consent!==ISSUE_CONSENT) throw Error('Consent required');
  const token='hct_'+base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash=await sha256Hex(token);
  const granted=new Date().toISOString();
  let results;
  try{results=await db.batch([
    db.prepare('UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND revoked_at IS NULL').bind(id),
    db.prepare('INSERT INTO health_connect_ingest_tokens(token_hash,user_id) VALUES(?1,?2)').bind(hash,id),
    db.prepare(
      'INSERT INTO health_import_consent(user_id,purpose,granted_at,withdrawn_at) VALUES(?1,?2,?3,NULL) '+
      'ON CONFLICT(user_id) DO UPDATE SET purpose=excluded.purpose,granted_at=excluded.granted_at,withdrawn_at=NULL'
    ).bind(id,CONSENT_PURPOSE,granted)
  ]);}catch{throw Error('Import unavailable');}
  if(!Array.isArray(results)||results.length!==3||results.some(r=>!r?.success)||results[1].meta?.changes!==1)
    throw Error('Import unavailable');
  return {
    header_name:'Authorization',
    header_value:'Bearer '+token,
    replaced_previous:(results[0].meta?.changes??0)>0,
    consent:'granted',
    shown_once:true,
    ...ISSUE_GUIDANCE
  };
}
export async function revokeIngestTokens(db,userId,confirm){
  const id=await requireMember(db,userId);
  if(confirm!==REVOKE_CONFIRM) throw Error('Consent required');
  let result;
  try{result=await db.prepare(
    'UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND revoked_at IS NULL'
  ).bind(id).run();}catch{throw Error('Import unavailable');}
  if(!result?.success) throw Error('Import unavailable');
  return {revoked:result.meta?.changes??0};
}
// observe (optional) receives the authenticated member id and the counts only,
// for sanitized diagnostics. It never receives the token, body or records.
export async function healthConnectWebhook(request,env,{now=Date.now(),maxBody=DEFAULT_MAX_BODY,maxHits=DEFAULT_MAX_HITS,maxStored=DEFAULT_MAX_STORED,observe=null}={}){
  if(env?.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')
    return fail(503,'Health Connect webhook is not activated');
  if(request.method!=='POST') return fail(405,'POST required');
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
    return fail(415,'JSON required');
  if(!env?.DB||typeof env.DB.prepare!=='function') return fail(503,'Health Connect webhook is unavailable');
  const token=bearer(request);
  if(!token) return fail(401,'Unauthorized');
  let hash;
  try{hash=await sha256Hex(token);}catch{return fail(503,'Health Connect webhook is unavailable');}
  let owner;
  try{owner=await env.DB.prepare(
    'SELECT user_id FROM health_connect_ingest_tokens WHERE token_hash=?1 AND revoked_at IS NULL'
  ).bind(hash).first();}catch{return fail(503,'Health Connect webhook is unavailable');}
  if(!owner?.user_id) return fail(401,'Unauthorized');
  if(observe)observe.userId=owner.user_id;
  let member,consent;
  try{
    member=await activeMembership(env.DB,owner.user_id);
    consent=await env.DB.prepare(
      'SELECT granted_at,withdrawn_at FROM health_import_consent WHERE user_id=?1 AND purpose=?2'
    ).bind(owner.user_id,CONSENT_PURPOSE).first();
  }catch{return fail(503,'Health Connect webhook is unavailable');}
  if(!member||!consent?.granted_at||consent.withdrawn_at){
    if(observe)observe.reason=member?'consent':'membership';
    return fail(403,'Not authorized');
  }
  let allowed;
  try{allowed=await consumeRate(env.DB,hash,now,maxHits);}catch{return fail(503,'Health Connect webhook is unavailable');}
  if(!allowed) return fail(429,'Too many requests');
  const body=await readBounded(request,maxBody);
  if(body.error==='too_large') return fail(413,'Payload too large');
  if(body.error) return fail(400,'Invalid payload');
  let data;
  try{data=JSON.parse(body.text);}catch{return fail(400,'Invalid payload');}
  let mapped;
  try{mapped=await mapWebhookPayload(data,{maxStored});}
  catch{return fail(503,'Health Connect webhook is unavailable');}
  if(mapped.error==='too_large') return fail(413,'Payload too large');
  if(mapped.error) return fail(400,'Invalid payload');
  let written=0;
  try{
    // D1 batch is transactional: no partial upload on a failed chunk, and
    // revocation/withdrawal cannot interleave between authorization and writes.
    const statements=[env.DB.prepare(
      'UPDATE health_connect_ingest_tokens SET window_hits=window_hits '+
      'WHERE user_id=?1 AND token_hash=?3 AND '+WRITE_AUTH
    ).bind(owner.user_id,null,hash)];
    for(const batch of chunkRows(mapped.rows))
      statements.push(env.DB.prepare(UPSERT).bind(owner.user_id,JSON.stringify(batch),hash));
    const results=await env.DB.batch(statements);
    if(!Array.isArray(results)||results.length!==statements.length||results.some(r=>!r?.success))
      return fail(503,'Health Connect webhook is unavailable');
    if(results[0].meta?.changes!==1)return fail(403,'Not authorized');
    // stored stays the accepted count (unchanged contract). written is what
    // the upsert actually changed; an older or unversioned copy of a newer
    // record is accepted but unchanged.
    let changed=0;
    for(const result of results.slice(1)){
      const n=result.meta?.changes;
      changed+=Number.isSafeInteger(n)&&n>=0?n:0;
    }
    written=Math.min(changed,mapped.rows.length);
  }catch{return fail(503,'Health Connect webhook is unavailable');}
  if(observe)observe.result={stored:mapped.rows.length,skipped:mapped.skipped,rejected:mapped.rejected};
  return httpJson({ok:true,stored:mapped.rows.length,written,unchanged:mapped.rows.length-written,skipped:mapped.skipped,skipped_types:mapped.skipped_types,rejected:mapped.rejected});
}
