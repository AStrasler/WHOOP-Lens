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
export async function requireSyncReady(db,userId,env,{revoking=false}={}){
 if(!revoking && env?.WEB_HEALTH_IMPORT_ENABLED!=='true')throw new CompanionSyncRejected(503,'feature_disabled');
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
 await requireSyncReady(db,userId,env,{revoking:true});
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
  await requireSyncReady(env.DB,userId,env,{revoking:request.method==='POST' && path==='/v1/health-connect/pause'});
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

// MCP parity for the member-visible companion controls that need no phone:
// read the sync status, and pause sync on an explicit member request.
export const COMPANION_PAUSE_CONFIRMATION='pause-my-health-connect-sync';
export const companionStatusTool=Object.freeze({
 name:'get_companion_sync_status',
 description:"Read the signed-in member's Health Connect companion sync status: whether sync is paused, consent state, stored record count, last successful sync time and the categories the WhoopLens phone app syncs. Read-only. It does not sync a phone, change consent or return health records.",
 inputSchema:{type:'object',properties:{},additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
});
export const companionPauseTool=Object.freeze({
 name:'pause_companion_sync',
 description:"Pause Health Connect companion sync for the signed-in member. Use ONLY when the member explicitly asks in this conversation to pause or stop phone sync; never infer it. Withdraws upload consent and revokes phone ingest tokens. Stored Health Connect records are kept (withdraw_health_connect_import deletes them). Sync resumes only when the member syncs again from the WhoopLens phone app.",
 inputSchema:{type:'object',properties:{confirm:{type:'string',const:COMPANION_PAUSE_CONFIRMATION}},required:['confirm'],additionalProperties:false},
 annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}
});
const on=(env,flag)=>env?.[flag]==='true';
// Status is part of the import feature. Pause stays reachable whenever any Health Connect
// path can hold consent or tokens, so a member can always stop uploads (same rule as withdrawal).
export function companionToolsFor(env){
 const tools=[];
 if(on(env,'WEB_HEALTH_IMPORT_ENABLED'))tools.push(companionStatusTool);
 if(on(env,'WEB_HEALTH_IMPORT_ENABLED')||on(env,'HEALTH_CONNECT_WEBHOOK_ENABLED'))tools.push(companionPauseTool);
 return tools;
}
export const isCompanionTool=name=>name===companionStatusTool.name||name===companionPauseTool.name;
export function companionSyncArguments(name,args){
 if(!args||typeof args!=='object'||Array.isArray(args))return null;
 const keys=Object.keys(args);
 if(name===companionStatusTool.name)return keys.length===0?{}:null;
 if(name===companionPauseTool.name)
  return keys.length===1&&keys[0]==='confirm'&&args.confirm===COMPANION_PAUSE_CONFIRMATION?{confirm:args.confirm}:null;
 return null;
}
export async function runCompanionSyncTool(name,args,{db,userId,env}){
 if(name===companionStatusTool.name){
  const status=await companionSyncStatus(db,userId,env);
  return {...status,note:status.paused?'Sync is paused or not set up. The member resumes it by syncing from the WhoopLens phone app.':'Sync runs only when the member starts it in the WhoopLens phone app.'};
 }
 if(name===companionPauseTool.name){
  const result=await pauseCompanionSync(db,userId,env,args.confirm);
  return {...result,changed_by:'member_request',note:'Uploads are paused and phone ingest tokens are revoked. Stored records were kept. The member resumes by syncing again from the WhoopLens phone app.'};
 }
 throw new CompanionSyncRejected(400,'invalid_request');
}
export function companionToolError(name,error){
 const code=error instanceof CompanionSyncRejected?error.code:'unavailable';
 const nothing=name===companionPauseTool.name?' Nothing was changed.':'';
 if(code==='feature_disabled')return 'Companion sync is not available right now.'+nothing;
 if(code==='not_authorized')return 'Companion sync is only available to active members.'+nothing;
 if(code==='migration_required')return 'Companion sync is not set up on this server yet.'+nothing;
 return 'Companion sync could not be reached. Retry shortly.'+nothing;
}
