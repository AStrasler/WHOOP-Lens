// Member-facing guidance shared by every account on this server: feature
// states, Health Connect token-versus-data status, seat-role boundaries and
// evidence labels. Read-only. Reports flags and this account's own counts and
// timestamps only; never a secret value, another member, or record content.
import {whoopConnectConfigured} from './whoop-oauth.mjs';
import {notionConfigured} from './notion-client.mjs';
import {analyticsConfigured} from './ai-account.mjs';
import {selectModel,aiSummaryEnabled} from './ai-summary.mjs';
import {memberLimits,memberLimitEnabled,missingTable} from './member-rate-limit.mjs';

// Source hierarchy for every AI host on this server. Returned verbatim by
// get_capabilities (source_hierarchy) and included in the host instructions.
export const SOURCE_HIERARCHY=Object.freeze([
  'WHOOP measurements are authoritative for the WHOOP data they represent (recovery, sleep, cycles, workouts, body measurements, profile). WhoopLens read tools label them source "whoop".',
  'Health Connect, Samsung Health and other existing integrations are supplementary. Keep their source label on every value you cite, and never present them as WHOOP data.',
  'Add other external sources or medical records only when the user directs it. Never bring one in at your own discretion or as a substitute for WHOOP data.',
  'Ground every interpretation in measurements retrieved in this conversation, citing tool and date. Keep measured facts separate from hypotheses and label hypotheses as such.',
  'When WHOOP measurements are missing or stale (whoop_measurements.missing or stale is true, or the latest record is older than the period asked about), say so plainly. Never silently fill the gap from another source.',
  'While WhoopLens is connected and in use, this hierarchy is required, not an optional recommendation. Only the user decides which additional sources to add; do not reorder or redefine it.',
  'User-entered WHOOP records (sleep, naps, activities or workouts the person entered manually, journal entries, symptoms and observations) are authoritative records of what the person reported. Do not dispute, dismiss or demand verification of them because they are not sensor-generated, and do not claim they were physiologically verified. Keep their original values, dates, descriptions and attribution; never silently correct, overwrite, reinterpret or discard them. Distinguish user-entered from sensor-generated only when the origin is explicit (an origin field, or the person says they entered it), without treating either as invalid; when whoop_measurements.entry_origin is unknown, keep it unknown and do not infer origin from fields such as nap or score_state (nap says a sleep was a nap, not who entered it). When records disagree, keep both and explain the difference without automatically favoring the sensor. Flag a technical inconsistency only with specific evidence; do not manufacture uncertainty.',
  'Source of truth: sensor measurements establish what WHOOP measured, manual entries establish what the person recorded, and user-provided context establishes what the person reports experiencing. Analyze all of them without disputing, rewriting or substituting any of them.'
]);
export const sourceHierarchyGuidance='Source hierarchy (required): '+SOURCE_HIERARCHY.map((r,i)=>`(${i+1}) ${r}`).join(' ');
// A listed tool whose server flag is off throws this, so the member is told the
// feature is off instead of a generic "WHOOP data is unavailable" message.
export class FeatureDisabled extends Error{
  constructor(feature){
    super(`This feature (${feature}) is turned off on this WhoopLens server. Nothing was changed. `+
      'get_capabilities lists which features are enabled, disabled or not configured.');
    this.name='FeatureDisabled';this.feature=feature;
  }
}
const on=(env,name)=>env?.[name]==='true';
function state(enabled,configured=true){return !enabled?'disabled':configured?'enabled':'not_configured';}
export function featureStates(env){
  // env is already resolved by the router (secrets.mjs), so this mirrors the
  // exact check connect_whoop runs. Presence only; no value is returned.
  const whoopConfigured=whoopConnectConfigured(env);
  // Summaries need the AI binding and the account analytics budget settings;
  // without the budget settings every summary falls back to a template.
  // An unsupported AI_SUMMARY_MODEL also means template-only.
  // Same binding check attachSummary uses: AI must be a callable Workers AI binding.
  const ai=typeof env?.AI?.run==='function'&&analyticsConfigured(env)&&selectModel(env)!==null;
  const features=[
    {id:'notion_daily_log',tools:['connect_notion','get_notion_status','disconnect_notion','list_notion_databases','get_notion_database_schema','configure_notion_daily_log','get_notion_daily_log','preview_notion_daily_log_update','save_notion_daily_log_update'],
      state:state(on(env,'NOTION_ENABLED'),notionConfigured(env))},
    {id:'whoop_connection',tools:['connect_whoop','disconnect_whoop'],
      state:state(on(env,'WHOOP_OAUTH_ENABLED'),whoopConfigured)},
    {id:'health_connect_file_import',tools:['import_health_connect_file'],
      state:state(on(env,'WEB_HEALTH_IMPORT_ENABLED'))},
    {id:'health_connect_phone_ingest',tools:['issue_health_connect_ingest_token','revoke_health_connect_ingest_token'],
      state:state(on(env,'HEALTH_CONNECT_WEBHOOK_ENABLED'))},
    {id:'health_connect_withdraw',tools:['withdraw_health_connect_import'],
      state:state(on(env,'WEB_HEALTH_IMPORT_ENABLED')||on(env,'HEALTH_CONNECT_WEBHOOK_ENABLED'))},
    {id:'ai_summaries',tools:['summary argument on WHOOP read tools'],
      state:state(on(env,'AI_SUMMARY_ENABLED'),ai)},
    {id:'weekly_digest',tools:['get_weekly_digest'],
      state:state(on(env,'WEEKLY_DIGEST_ENABLED'))},
    {id:'experimental_stress_estimate',tools:['summary argument on WHOOP read tools'],
      // Computed without the model, so it follows the two flags only (the same
      // rule as the summary path and host instructions).
      state:state(on(env,'STRESS_ESTIMATE_ENABLED')&&on(env,'AI_SUMMARY_ENABLED'))},
    {id:'flare_journal',tools:['set_flare_consent','get_flare_journal'],
      state:state(on(env,'FLARE_JOURNAL_ENABLED'))},
    {id:'service_announcements',tools:['list_service_announcements'],
      state:state(on(env,'ANNOUNCEMENTS_ENABLED'))}
  ];
  return features.map(f=>({...f,reason:f.state==='enabled'?'Server flag is on and required settings are present.':
    f.state==='disabled'?'Server flag is off. Its tools may still be listed but return a feature-off message.':
    'Server flag is on but a required setting or binding is missing, so calls may fail or fall back to a template.'}));
}
export const ROLE_BOUNDARIES=Object.freeze({
  shared:['Every seat, including the owner, reads, imports, connects and deletes only its own account data.',
    'No MCP tool approves members, changes seats or roles, rotates another account\'s token, or reads another account\'s data.'],
  developer:['This is the owner/developer seat.','Member approval and seat changes happen outside this MCP, by the owner.'],
  // Only when the owner setting names this account: the same rule get_ai_usage uses.
  ownerUsage:'get_ai_usage also returns a server-wide AI summary total with no per-member breakdown.',
  public:['This is an approved member seat.','To change membership or seats, ask the server owner; this MCP cannot do it.'],
  // Only while get_ai_usage is listed (AI_SUMMARY_ENABLED).
  memberUsage:'get_ai_usage shows this account only.'
});
// Issue reports (ISSUE_REPORTS_ENABLED) are the one cross-account view: the
// owner reads every member's sanitized reports. Say so on both sides.
const REPORT_BOUNDARIES=Object.freeze({
  member:'Issue reports this account submits with report_issue are visible to the server owner: the approved description after best-effort cleaning (numbers, links, contact details and recognizable credentials removed; a secret written in another form can be missed; other words, including any health or personal details the member writes, are shared as written), plus diagnostic codes (no health data). Leave health and personal details and any passwords out of a report.',
  owner:'review_issue_reports shows every member\'s issue reports without account ids: member-written descriptions after best-effort cleaning (numbers, links, contact details and recognizable credentials removed, though a secret in another form can be missed; other words, which may include health or personal details, are as written), and diagnostic codes (no health data). It is the only cross-account view.',
  // Captured whether or not the member ever submits a report.
  diagnostics:'This server records sanitized failure codes for every signed-in member, whether or not they submit a report (codes, counts and times only; no health data, message text or tokens). The server owner can see them, as server-wide 24-hour counts in review_issue_reports, and they expire after 30 days.'
});
const ANNOUNCEMENT_BOUNDARIES=Object.freeze({
  member:'Service announcements addressed to this account or to all members can be read while they are active. The audience list and other account ids are not included. Announcement text is a service notice, not health data.',
  owner:'Creating, editing, scheduling, expiring and targeting announcements is owner-only. This is the announcement exception to the own-account rule: manage_service_announcements lists notice text and the pseudonymous member ids you targeted. It does not include health data, names or emails. Members never receive that list.'
});
function boundaries(seatRole,owner,env){
  const usage=aiSummaryEnabled(env)?[owner?ROLE_BOUNDARIES.ownerUsage:ROLE_BOUNDARIES.memberUsage]:[];
  const reports=[...(env?.ISSUE_REPORTS_ENABLED==='true'?[owner?REPORT_BOUNDARIES.owner:REPORT_BOUNDARIES.member]:[]),
    ...(env?.DIAGNOSTICS_CAPTURE_ENABLED==='true'?[REPORT_BOUNDARIES.diagnostics]:[])];
  const announcements=env?.ANNOUNCEMENTS_ENABLED==='true'?[owner?ANNOUNCEMENT_BOUNDARIES.owner:ANNOUNCEMENT_BOUNDARIES.member]:[];
  return [...ROLE_BOUNDARIES.shared,...(seatRole?ROLE_BOUNDARIES[seatRole]:[]),...usage,...reports,...announcements];
}
const BUDGET_PROBE_SQL='SELECT 1 FROM whoop_member_request_budget WHERE user_id=?1 LIMIT 1';
const ROLE_SQL='SELECT seat_role FROM whoop_connections WHERE user_id=?1 LIMIT 1';
// One statement, so token, consent and record fields come from one consistent
// database snapshot (a concurrent issue, revoke or withdrawal cannot split it).
const HC_STATUS_SQL='SELECT '+
  '(SELECT created_at FROM health_connect_ingest_tokens WHERE user_id=?1 AND revoked_at IS NULL LIMIT 1) AS token_created,'+
  '(SELECT window_started_at FROM health_connect_ingest_tokens WHERE user_id=?1 AND revoked_at IS NULL LIMIT 1) AS token_window,'+
  '(SELECT COUNT(*) FROM health_connect_ingest_tokens WHERE user_id=?1 AND revoked_at IS NULL) AS active_tokens,'+
  '(SELECT COUNT(*) FROM health_connect_ingest_tokens WHERE user_id=?1) AS all_tokens,'+
  '(SELECT COUNT(*) FROM health_connect_records WHERE user_id=?1) AS records,'+
  '(SELECT MAX(created_at) FROM health_connect_records WHERE user_id=?1) AS latest_created,'+
  '(SELECT MAX(updated_at) FROM health_connect_records WHERE user_id=?1) AS latest_updated,'+
  '(SELECT COUNT(*) FROM health_import_consent WHERE user_id=?1) AS consent_rows,'+
  '(SELECT withdrawn_at FROM health_import_consent WHERE user_id=?1 LIMIT 1) AS consent_withdrawn';
// Stored timestamps are UTC (D1 CURRENT_TIMESTAMP or ISO). Report ISO-8601 Z.
function utc(value){
  if(typeof value!=='string'||!value)return null;
  const text=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)?value.replace(' ','T')+'Z':value;
  const time=Date.parse(text);
  return Number.isFinite(time)?new Date(time).toISOString():null;
}
// One failed status read never hides the catalog: that field reads unknown.
const UNREAD=Symbol('unread');
async function read(db,sql,userId){
  try{return await db.prepare(sql).bind(userId).first()??null;}catch{return UNREAD;}
}
export async function accountStatus(db,userId,env,{now=Date.now()}={}){
  const roleRow=await read(db,ROLE_SQL,userId);
  const role=roleRow===UNREAD?undefined:roleRow?.seat_role;
  // The owner setting is the same rule get_ai_usage uses, so the owner stays
  // the developer seat even after disconnecting WHOOP.
  const owner=typeof env?.WHOOP_LENS_DEVELOPER_USER_ID==='string'&&env.WHOOP_LENS_DEVELOPER_USER_ID.length>0&&env.WHOOP_LENS_DEVELOPER_USER_ID===userId;
  const seat_role=owner?'developer':role==='developer'||role==='public'?role:null;
  const seat_role_source=owner?'Server owner setting.':roleRow===UNREAD?'Could not be read right now.':seat_role?
    'This account\'s WHOOP connection record.':'No WHOOP connection record yet, so the seat role is not recorded.';
  // Same seat class the limiter uses: whoop_connections.seat_role. Without a
  // connection row no WHOOP request is made, so no budget applies. Reported in
  // both response paths.
  let request_budget=!memberLimitEnabled(env)?{state:'disabled'}:roleRow===UNREAD?{state:'unknown'}:!roleRow?
      {state:'not_applicable',reason:'No WHOOP connection, so no WHOOP requests are made.'}:
      {state:'enabled',...memberLimits(env)[role==='developer'?'developer':'public']};
  // The limiter skips enforcement when its table (migration 0015) is absent,
  // so "enabled" is reported only when that table is readable.
  if(request_budget.state==='enabled'){
    try{await db.prepare(BUDGET_PROBE_SQL).bind(userId).first();}
    catch(error){request_budget=missingTable(error,'whoop_member_request_budget')?
      {state:'not_configured',reason:'The request limiter is not set up on this server, so no per-member limit is enforced.'}:{state:'unknown'};}
  }
  const hc=await read(db,HC_STATUS_SQL,userId);
  if(hc===UNREAD||!hc)return {
    as_of:new Date(now).toISOString(),seat_role:seat_role??'unknown',seat_role_source,
    role_boundaries:boundaries(seat_role,owner,env),
    whoop_connected:roleRow===UNREAD?'unknown':!!roleRow,
    health_connect:{status:'unknown',summary:'Health Connect status could not be read right now. Treat it as unverified.'},
    request_budget
  };
  const count=Number(hc.records??0);
  const active=Number(hc.active_tokens??0)>0;
  const tokenState=active?'active':Number(hc.all_tokens??0)>0?'revoked':'none';
  const flag=on(env,'HEALTH_CONNECT_WEBHOOK_ENABLED')?'enabled':'disabled';
  const latest=[utc(hc.latest_created),utc(hc.latest_updated)].filter(Boolean).sort().pop()??null;
  let summary;
  if(count>0)summary=`${count} Health Connect record(s) are stored for this account. Read them with get_health_connect.`;
  else if(tokenState==='active')summary='An ingest token is issued, but no Health Connect records are stored for this account yet. '+
    'A token is only a credential: data arrives only when the phone app sends supported records with it.';
  else summary='No Health Connect records are stored for this account.';
  return {
    as_of:new Date(now).toISOString(),
    seat_role:seat_role??'unknown',
    seat_role_source,
    role_boundaries:boundaries(seat_role,owner,env),
    whoop_connected:roleRow===UNREAD?'unknown':!!roleRow,
    health_connect:{
      phone_ingest_feature:flag,
      ingest_token:tokenState,
      token_issued_at:active?utc(hc.token_created):null,
      // Set when a request authenticated with the active token opened a new
      // 15-minute rate window. It says nothing about whether records were stored.
      latest_authenticated_delivery_window_at:active?utc(hc.token_window):null,
      records_stored:count,
      latest_record_stored_at:latest,
      storage_consent:Number(hc.consent_rows??0)>0?(hc.consent_withdrawn?'withdrawn':'granted'):'none',
      summary,
      evidence:'Counts and timestamps for this account only, read at as_of. No record content.',
      not_verifiable_here:['Whether the phone app has Health Connect permissions, ran a sync, or which types it sent.',
        'The response the phone app received for a delivery. An accepted delivery can store zero records.']
    },
    // Same seat class the limiter uses: whoop_connections.seat_role. Without a
    // connection row no WHOOP request is made, so no budget applies.
    request_budget
  };
}
export const ISSUE_GUIDANCE=Object.freeze({
  // Scoped to this call: issuing or replacing a token never delivers data.
  this_call_delivered_data:false,
  next_step:'Enter header_name and header_value in the phone app, then let it sync. Issuing this token does not mean any data has arrived. Records already stored for this account are unchanged.',
  verify_with:'get_capabilities account.health_connect.records_stored, or get_health_connect',
  note:'A delivery can be accepted and still store zero records, for example when it has no supported types or permitted data.'
});
