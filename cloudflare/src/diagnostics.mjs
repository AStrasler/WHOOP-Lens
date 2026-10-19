// Sanitized server-side diagnostics. Each event is a fixed category, subsystem
// and code, an outcome, a retry hint, a timestamp, a request id and (only when
// known) the internal member id. Never a message string, health value, chat
// text, token, secret, header or URL. Capture never throws and never changes
// the response it describes.
import {SeatsFull} from './seat-limit.mjs';
import {CursorError} from './history-pagination.mjs';
import {FeatureDisabled} from './member-guidance.mjs';

export const CATEGORIES=Object.freeze(['whoop_api','auth','rate_limit','health_connect','ai_summary','mcp_validation',
  'mcp_tool','infrastructure','authorization','consent','setup']);
// What the member is told the problem is (see host instructions).
export const KINDS=Object.freeze(['temporary','missing_consent','incomplete_setup','unavailable_data','backend_failure','other']);
const OUTCOMES=new Set(['success','fail','partial']);
const CODE=/^[a-z0-9_]{1,64}$/;
const SUBSYSTEM=/^[a-z0-9_]{1,40}$/;
const REQUEST_ID=/^[a-z0-9_]{8,40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BUCKET_MS=10*60*1000;
export const RETENTION_DAYS=30;
export const REPORT_RETENTION_DAYS=180;
// Retention for the report queue (issue-reports.mjs). Kept here so every
// diagnostic write can run it without an import cycle.
export const PURGE_REPORTS='DELETE FROM issue_reports WHERE reference IN (SELECT reference FROM issue_reports '+
  "WHERE status='resolved' AND updated_at<?1 ORDER BY updated_at LIMIT 20)";
export const PURGE_APPROVALS='DELETE FROM issue_report_approvals WHERE token_hash IN '+
  '(SELECT token_hash FROM issue_report_approvals WHERE expires_at<=?1 LIMIT 50)';
export function retentionStatements(db,now){
  return [db.prepare(PURGE_REPORTS).bind(new Date(now-REPORT_RETENTION_DAYS*86400000).toISOString()),
    db.prepare(PURGE_APPROVALS).bind(now)];
}

export function diagnosticsEnabled(env){return env?.DIAGNOSTICS_CAPTURE_ENABLED==='true';}
export function newRequestId(){
  const bytes=crypto.getRandomValues(new Uint8Array(8));
  return 'req_'+[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function validRequestId(value){return typeof value==='string'&&REQUEST_ID.test(value);}
// Only allowlisted shapes survive; anything else becomes null (not captured).
export function sanitizeEvent(event,{now=Date.now()}={}){
  if(!event||typeof event!=='object')return null;
  const {category,subsystem,code,outcome,retryable,requestId,userId}=event;
  if(!CATEGORIES.includes(category)||!SUBSYSTEM.test(subsystem??'')||!CODE.test(code??''))return null;
  if(!OUTCOMES.has(outcome)||!validRequestId(requestId))return null;
  const user=typeof userId==='string'&&UUID.test(userId.toLowerCase())?userId.toLowerCase():'';
  return {category,subsystem,code,outcome,retryable:retryable===true,request_id:requestId,user_key:user,
    at:new Date(now).toISOString(),bucket:Math.floor(now/BUCKET_MS)*BUCKET_MS};
}
const UPSERT='INSERT INTO diagnostic_events(user_key,category,subsystem,code,outcome,retryable,bucket,count,first_at,last_at,request_id) '+
  'VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?8,?9) ON CONFLICT(user_key,subsystem,code,outcome,bucket) DO UPDATE SET '+
  'count=count+1,last_at=excluded.last_at,request_id=excluded.request_id WHERE diagnostic_events.count<?10';
// Writes per member, code and 10-minute bucket stop here: further repeats
// change nothing in D1 (count reads as "at least" this many).
export const BUCKET_WRITE_CAP=20;
// Bounded retention sweep: at most 50 expired rows per write, index-backed.
const SWEEP='DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events WHERE last_at<?1 ORDER BY last_at LIMIT 50)';
export async function capture(env,db,event,{now=Date.now()}={}){
  const clean=sanitizeEvent(event,{now});
  if(!clean)return false;
  // The console line (Workers observability) carries no member id.
  try{console.log(JSON.stringify({event:'diag',category:clean.category,subsystem:clean.subsystem,code:clean.code,
    outcome:clean.outcome,retryable:clean.retryable,request_id:clean.request_id}));}catch{/* diagnostics only */}
  if(!db||typeof db.prepare!=='function'||typeof db.batch!=='function')return false;
  // Only events tied to an authenticated member reach D1. Anyone on the
  // internet can produce pre-authentication failures (bad bearer, unknown
  // client), so those stay console-only and never cause a database write.
  if(!clean.user_key)return false;
  // Rate-limited retries are the flood case by definition: the limiter already
  // logs them, so they never cause a D1 write either.
  if(clean.category==='rate_limit')return false;
  const cutoff=new Date(now-RETENTION_DAYS*86400000).toISOString();
  if(!diagnosticsEnabled(env)){
    // Capture is off, but rows collected earlier still expire on schedule.
    // Before the migration the tables do not exist and this is a no-op.
    try{await db.batch([db.prepare(SWEEP).bind(cutoff),...retentionStatements(db,now)]);}catch{/* retried next time */}
    return false;
  }
  try{
    const results=await db.batch([
      db.prepare(UPSERT).bind(clean.user_key,clean.category,clean.subsystem,clean.code,clean.outcome,
        clean.retryable?1:0,clean.bucket,clean.at,clean.request_id,BUCKET_WRITE_CAP),
      db.prepare(SWEEP).bind(cutoff),
      // Report retention also runs here, so it does not depend on new reports.
      ...retentionStatements(db,now)
    ]);
    return Array.isArray(results)&&results[0]?.success===true;
  }catch{return false;}
}
export function toolSubsystem(name){
  if(['get_profile','get_body_measurements','get_recovery','get_sleep','get_workouts','get_cycles'].includes(name))return 'whoop_api';
  if(name==='issue_health_connect_ingest_token'||name==='revoke_health_connect_ingest_token')return 'hc_token';
  if(name==='import_health_connect_file')return 'hc_import';
  if(name==='withdraw_health_connect_import')return 'hc_consent';
  if(name==='get_health_connect')return 'hc_storage';
  if(name==='connect_whoop'||name==='disconnect_whoop')return 'whoop_oauth';
  if(name==='get_ai_usage')return 'ai_summary';
  if(name==='get_weekly_digest')return 'weekly_digest';
  if(name==='report_issue'||name==='review_issue_reports'||name==='update_issue_report')return 'issue_reports';
  if(typeof name==='string'&&/^[a-z_]{1,40}$/.test(name)&&/flare/.test(name))return 'flare_journal';
  return 'mcp_tool';
}
// Error -> fixed classification. Only error types and our own fixed message
// strings are matched; the message itself is never stored.
export function classifyToolError(error,name){
  const subsystem=toolSubsystem(name);
  const message=error instanceof Error?error.message:'';
  const c=(category,code,retryable,kind)=>({category,subsystem,code,retryable,kind});
  if(error instanceof SeatsFull)return c('authorization','seats_full',false,'incomplete_setup');
  if(error instanceof FeatureDisabled)return c('setup','feature_disabled',false,'incomplete_setup');
  if(error instanceof CursorError)return c('mcp_validation',error.reason==='expired'?'cursor_expired':'cursor_invalid',true,'temporary');
  if(error?.status===429)return c('rate_limit',error.memberLimit===true?'member_budget_exhausted':'whoop_rate_limited',true,'temporary');
  if(/flare/.test(subsystem))return c('mcp_tool','flare_failed',false,'other');
  if(message==='Consent required')return c('consent','consent_missing',false,'missing_consent');
  if(message==='Not authorized'||message==='Membership required')return c('authorization','membership_inactive',false,'incomplete_setup');
  if(message==='WHOOP connection required'||message==='digest')return c('setup','whoop_not_connected_or_no_data',false,'unavailable_data');
  if(/^WHOOP refresh|^Invalid WHOOP refresh/.test(message))return c('auth','whoop_refresh_failed',true,'temporary');
  if(message==='WHOOP OAuth not configured'||message==='Token key unavailable'||/not configured/.test(message))
    return c('setup','server_not_configured',false,'backend_failure');
  if(message==='WHOOP API request failed'){
    if(error?.status===401||error?.status===403)return c('auth','whoop_token_rejected',false,'incomplete_setup');
    if(error?.status>=500)return c('whoop_api','whoop_upstream_error',true,'temporary');
    return c('whoop_api','whoop_request_failed',true,'temporary');
  }
  if(/^WHOOP response/.test(message))return c('whoop_api','whoop_response_invalid',true,'temporary');
  if(message==='Import unavailable')return c('health_connect','hc_storage_unavailable',true,'backend_failure');
  if(message==='quota')return c('ai_summary','quota_unavailable',true,'temporary');
  if(/D1|SQLITE|database/i.test(message))return c('infrastructure','db_error',true,'backend_failure');
  return c('mcp_tool','tool_failed',true,'backend_failure');
}
// Health Connect webhook response status -> classification (no member id is
// known for a request that failed authentication).
export function classifyWebhookStatus(status){
  if(status===401||status===403)return {category:'authorization',code:'hc_token_rejected',retryable:false};
  if(status===400)return {category:'health_connect',code:'hc_payload_invalid',retryable:false};
  if(status===413)return {category:'health_connect',code:'hc_payload_too_large',retryable:false};
  if(status===415)return {category:'health_connect',code:'hc_content_type_invalid',retryable:false};
  if(status===405)return {category:'health_connect',code:'hc_method_invalid',retryable:false};
  if(status===429)return {category:'rate_limit',code:'hc_rate_limited',retryable:true};
  if(status>=500)return {category:'infrastructure',code:'hc_unavailable',retryable:true};
  return null;
}
