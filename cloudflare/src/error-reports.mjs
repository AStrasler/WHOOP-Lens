// Structured client-reported diagnostics. The authenticated identity and live
// connection generation, never link_id alone, authorize a report.
import {activeMembership} from './storage.mjs';
import {issueReportsEnabled,isOwner,reportIssue,ReportNotSubmitted} from './issue-reports.mjs';
import {validRequestId} from './diagnostics.mjs';
const LINK=/^lnk_[0-9a-f]{64}$/;
export const ERROR_CODES=Object.freeze(['reconnect_loop','metadata_unavailable','authorization_failed','refresh_failed',
  'rate_limited','request_failed','data_unavailable','journal_failed','unexpected_response']);
export const ERROR_STAGES=Object.freeze(['mcp','oauth','whoop_api','flare_journal','notion']);
export const ERROR_OPERATIONS=Object.freeze(['initialize','server/discover','tools/list','oauth_authorize','oauth_token',
  'get_profile','get_body_measurements','get_cycles','get_recovery','get_sleep','get_workouts','get_flare_journal','save_flare_entry',
  'get_notion_daily_log','preview_notion_daily_log_update','save_notion_daily_log_update']);
const HTTP_STATUSES=[0,400,401,403,404,408,409,413,429,500,502,503,504];
const diagnosticSchema={type:'object',properties:{
  code:{type:'string',enum:ERROR_CODES},stage:{type:'string',enum:ERROR_STAGES},operation:{type:'string',enum:ERROR_OPERATIONS},
  http_status:{type:'integer',enum:HTTP_STATUSES},occurred_at:{type:'string',format:'date-time'},
  request_id:{type:'string',pattern:'^[a-z0-9_]{8,40}$',description:'Optional server request ID. Must match a recent diagnostic event belonging to this member.'}
},required:['code','stage','operation'],additionalProperties:false};
export const errorReportTools=Object.freeze([
  {name:'get_reportable_links',description:'Owner only. Return eligible linked WHOOP account handles for the authenticated owner’s own account. Never returns another member’s links.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
  {name:'report_error',description:'Report structured WhoopLens diagnostics for an eligible link_id belonging to this member. Accepts only fixed codes, stages, operations, status, time and an optional verified own request ID; no free text, URLs, tokens or health values. First call previews the exact diagnostics for the member. Only after approval, resend the identical payload with approved:true. No WHOOP connection state is changed.',
    inputSchema:{type:'object',properties:{link_id:{type:'string',pattern:'^lnk_[0-9a-f]{64}$'},diagnostics:diagnosticSchema,
      approved:{type:'boolean',const:true}},required:['link_id','diagnostics'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
]);
export const isErrorReportTool=name=>errorReportTools.some(t=>t.name===name);
export function errorReportToolsFor(env,userId){
  if(!issueReportsEnabled(env))return [];
  return errorReportTools.filter(t=>t.name!=='get_reportable_links'||isOwner(env,userId));
}
export function errorReportArguments(name,args){
  if(!args||typeof args!=='object'||Array.isArray(args))return null;
  if(name==='get_reportable_links')return Object.keys(args).length===0?{}:null;
  if(name!=='report_error'||Object.keys(args).some(k=>!['link_id','diagnostics','approved'].includes(k))||!LINK.test(args.link_id)||
     (args.approved!==undefined&&args.approved!==true))return null;
  const d=args.diagnostics;
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!Object.hasOwn(diagnosticSchema.properties,k))||
     !ERROR_CODES.includes(d.code)||!ERROR_STAGES.includes(d.stage)||!ERROR_OPERATIONS.includes(d.operation))return null;
  if(d.http_status!==undefined&&!HTTP_STATUSES.includes(d.http_status))return null;
  if(d.request_id!==undefined&&!validRequestId(d.request_id))return null;
  if(d.occurred_at!==undefined&&(typeof d.occurred_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.occurred_at)||
      !Number.isFinite(Date.parse(d.occurred_at))||new Date(d.occurred_at).toISOString()!==d.occurred_at))return null;
  // Rebuild in canonical key order so a JSON key reorder cannot alter approval.
  const diagnostics={code:d.code,stage:d.stage,operation:d.operation};
  for(const key of ['http_status','occurred_at','request_id'])if(d[key]!==undefined)diagnostics[key]=d[key];
  return {link_id:args.link_id,diagnostics,...(args.approved?{approved:true}:{})};
}
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function eligibleLink(db,userId){
  if(!await activeMembership(db,userId))throw new ReportNotSubmitted('invalid_link');
  let row;
  try{row=await db.prepare('SELECT g.generation FROM whoop_connection_generations g INNER JOIN whoop_connections c ON c.user_id=g.user_id WHERE g.user_id=?1 LIMIT 1').bind(userId).first();}
  catch{throw new ReportNotSubmitted('unavailable');}
  if(!row||!Number.isSafeInteger(row.generation)||row.generation<1)return null;
  return {generation:row.generation,link_id:'lnk_'+await hash('WHOOP-Lens/report-link/v1\n'+userId+'\n'+row.generation),provider:'whoop'};
}
export async function runErrorReportTool(name,args,{db,userId,env,requestId,now=Date.now()}={}){
  // Enforce at the shared execution boundary too: stale cached inventories
  // and direct callers must not bypass owner-only link discovery.
  if(!errorReportToolsFor(env,userId).some(t=>t.name===name))throw new ReportNotSubmitted('unavailable');
  const parsed=errorReportArguments(name,args);
  if(!parsed)throw new ReportNotSubmitted('unavailable');
  const link=await eligibleLink(db,userId);
  if(name==='get_reportable_links')return {links:link?[{link_id:link.link_id,provider:link.provider,eligible:true}]:[],
    eligibility:'Only an active member’s currently stored WHOOP connection is eligible. A handle is not an authorization credential.'};
  if(!link||link.link_id!==parsed.link_id)throw new ReportNotSubmitted('invalid_link');
  const d=parsed.diagnostics;
  if(d.occurred_at!==undefined&&(Date.parse(d.occurred_at)<now-86400000||Date.parse(d.occurred_at)>now+300000))throw new ReportNotSubmitted('unavailable');
  if(d.request_id){
    const evidence=await db.prepare('SELECT request_id FROM diagnostic_events WHERE user_key=?1 AND request_id=?2 AND last_at>?3 LIMIT 1')
      .bind(userId,d.request_id,new Date(now-86400000).toISOString()).first();
    if(!evidence)throw new ReportNotSubmitted('unavailable');
  }
  const category=['authorization_failed','refresh_failed','metadata_unavailable','reconnect_loop'].includes(d.code)?'backend_failure':
    d.code==='data_unavailable'?'unavailable_data':'temporary';
  const publicEvidence={source:'client_reported',link_id:link.link_id,provider:'whoop',diagnostics:d,
    verification:'Link eligibility and any request ID are verified; client-reported cause and status are not independently established.'};
  const result=await reportIssue(db,userId,{category,description:'Structured WhoopLens diagnostic report',approved:parsed.approved},
    {requestId,env,now,structuredReport:{generation:link.generation,publicEvidence}});
  if(!result.submitted)return {...result,link_id:link.link_id,diagnostics:d,
    next_step:'Show the link provider and the exact structured diagnostics to the member. If they approve, call report_error with the identical link_id and diagnostics and approved:true. No report exists yet.'};
  return {...result,connection_unchanged:true};
}
