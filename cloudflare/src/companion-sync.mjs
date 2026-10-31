// Explicit, member-initiated companion sync. Reuses the existing v2 parser,
// atomic upserts, consent record and lifecycle fence; never schedules uploads.
import {activeMembership} from './storage.mjs';
import {healthConnectStatus,importHealthConnectFile} from './health-import.mjs';
import {advanceHealthFence,healthImportAdmission} from './health-consent-fence.mjs';
import {readBounded} from './bounded-body.mjs';

const REQUIRED=['companion_sync_status','health_connect_records','health_import_consent','health_import_fences','health_connect_ingest_tokens','health_connect_member_deactivated','health_connect_member_removed'];
export class CompanionSyncRejected extends Error{
 constructor(status,code){super(code);this.status=status;this.code=code;}
}
export async function requireSyncReady(db,userId,env){
 if(env?.WEB_HEALTH_IMPORT_ENABLED!=='true')throw new CompanionSyncRejected(503,'feature_disabled');
 if(!await activeMembership(db,userId))throw new CompanionSyncRejected(403,'not_authorized');
 const rows=(await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all())?.results??[];
 if(!REQUIRED.every(name=>rows.some(row=>row.name===name)))throw new CompanionSyncRejected(503,'migration_required');
}
export async function companionSyncStatus(db,userId,env){
 await requireSyncReady(db,userId,env);
 const status=await healthConnectStatus(db,userId);
 const synced=await db.prepare('SELECT last_sync_at FROM companion_sync_status WHERE user_id=?1').bind(userId).first();
 return {...status,sync_protocol:1,enabled:true,manual_only:true,paused:status.consent!=='granted',last_sync_at:synced?.last_sync_at??null,
   categories:['steps','heart','sleep','exercise']};
}
export async function pauseCompanionSync(db,userId,env,consent){
 await requireSyncReady(db,userId,env);
 if(consent!=='pause-my-health-connect-sync')throw new CompanionSyncRejected(400,'consent_required');
 const result=await db.batch([
  db.prepare('UPDATE health_import_consent SET withdrawn_at=CURRENT_TIMESTAMP WHERE user_id=?1').bind(userId),
  db.prepare('UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?1 AND revoked_at IS NULL').bind(userId),
  advanceHealthFence(db,userId)
 ]);
 if(result.some(r=>!r?.success))throw new CompanionSyncRejected(503,'sync_unavailable');
 return {paused:true,consent:'withdrawn',records_retained:true,ingest_tokens_revoked:result[1].meta?.changes??0};
}
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",'referrer-policy':'no-referrer'}});
export async function companionSyncHttp(request,env,userId){
 try{
  const path=new URL(request.url).pathname;
  await requireSyncReady(env.DB,userId,env);
  if(request.method==='GET'&&path==='/v1/health-connect/sync-status')return json(await companionSyncStatus(env.DB,userId,env));
  if(request.method!=='POST'||!['/v1/health-connect/sync','/v1/health-connect/pause'].includes(path))return json({code:'unsupported_method'},405);
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return json({code:'not_authorized'},403);
  if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json'))return json({code:'json_required'},415);
  const generation=path.endsWith('/sync')?await healthImportAdmission(env.DB,userId):null;
  const bounded=await readBounded(request,path.endsWith('/sync')?512000:512);
  if(bounded.error)return json({code:'invalid_request'},400);
  let body;try{body=JSON.parse(bounded.text);}catch{return json({code:'invalid_request'},400);}
  if(path.endsWith('/pause'))return json(await pauseCompanionSync(env.DB,userId,env,body?.consent));
  if(body?.consent!=='store-health-connect-file')throw new CompanionSyncRejected(400,'consent_required');
  if(!body.file||!Array.isArray(body.file.records)||body.file.records.length<1)return json({code:'empty_preview'},400);
  const now=Date.now();
  const saved=await importHealthConnectFile(env.DB,userId,body.file,body.consent,{generation,now,manualSync:true});
  return json({...saved,sync_protocol:1,synced_at:new Date(now).toISOString()});
 }catch(error){
  if(error instanceof CompanionSyncRejected)return json({error:'Cloud sync is not available for this request.',code:error.code},error.status);
  return json({error:'Cloud sync was not confirmed.',code:'sync_unavailable'},503);
 }
}
