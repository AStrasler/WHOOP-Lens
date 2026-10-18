// Member-facing guidance shared by every account on this server: feature
// states, Health Connect token-versus-data status, seat-role boundaries and
// evidence labels. Read-only. Reports flags and this account's own counts and
// timestamps only; never a secret value, another member, or record content.
import {whoopConnectConfigured} from './whoop-oauth.mjs';
import {analyticsConfigured} from './ai-account.mjs';
import {selectModel} from './ai-summary.mjs';
import {memberLimits,memberLimitEnabled} from './member-rate-limit.mjs';

// A listed tool whose server flag is off throws this, so the member is told the
// feature is off instead of a generic "WHOOP data is unavailable" message.
export class FeatureDisabled extends Error{
  constructor(feature){
    super(`This feature (${feature}) is turned off on this WHOOP Lens server. Nothing was changed. `+
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
  const ai=!!env?.AI&&analyticsConfigured(env)&&selectModel(env)!==null;
  const features=[
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
      state:state(on(env,'FLARE_JOURNAL_ENABLED'))}
  ];
  return features.map(f=>({...f,reason:f.state==='enabled'?'Server flag is on and required settings are present.':
    f.state==='disabled'?'Server flag is off. Its tools may still be listed but return a feature-off message.':
    'Server flag is on but a required setting or binding is missing, so calls may fail or fall back to a template.'}));
}
export const ROLE_BOUNDARIES=Object.freeze({
  shared:['Every seat, including the owner, reads, imports, connects and deletes only its own account data.',
    'No MCP tool approves members, changes seats or roles, rotates another account\'s token, or reads another account.'],
  developer:['This is the owner/developer seat.','Member approval and seat changes happen outside this MCP, by the owner.'],
  // Only when the owner setting names this account: the same rule get_ai_usage uses.
  ownerUsage:'get_ai_usage also returns a server-wide AI summary total with no per-member breakdown.',
  public:['This is an approved member seat. get_ai_usage shows this account only.',
    'To change membership or seats, ask the server owner; this MCP cannot do it.']
});
function boundaries(seatRole,owner){
  return [...ROLE_BOUNDARIES.shared,...(seatRole?ROLE_BOUNDARIES[seatRole]:[]),...(owner?[ROLE_BOUNDARIES.ownerUsage]:[])];
}
const ROLE_SQL='SELECT seat_role FROM whoop_connections WHERE user_id=?1 LIMIT 1';
const TOKEN_SQL='SELECT created_at,window_started_at FROM health_connect_ingest_tokens '+
  'WHERE user_id=?1 AND revoked_at IS NULL LIMIT 1';
const ANY_TOKEN_SQL='SELECT COUNT(*) AS n FROM health_connect_ingest_tokens WHERE user_id=?1';
const RECORDS_SQL='SELECT COUNT(*) AS n,MAX(created_at) AS latest_created,MAX(updated_at) AS latest_updated '+
  'FROM health_connect_records WHERE user_id=?1';
const CONSENT_SQL='SELECT granted_at,withdrawn_at FROM health_import_consent WHERE user_id=?1 LIMIT 1';
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
  const token=await read(db,TOKEN_SQL,userId);
  const issued=await read(db,ANY_TOKEN_SQL,userId);
  const records=await read(db,RECORDS_SQL,userId);
  const consent=await read(db,CONSENT_SQL,userId);
  if([token,issued,records,consent].includes(UNREAD))return {
    as_of:new Date(now).toISOString(),seat_role:seat_role??'unknown',seat_role_source,
    role_boundaries:boundaries(seat_role,owner),
    whoop_connected:roleRow===UNREAD?'unknown':!!roleRow,
    health_connect:{status:'unknown',summary:'Health Connect status could not be read right now. Treat it as unverified.'}
  };
  const everIssued=Number(issued?.n??0)>0;
  const count=Number(records?.n??0);
  const tokenState=token?'active':everIssued?'revoked':'none';
  const flag=on(env,'HEALTH_CONNECT_WEBHOOK_ENABLED')?'enabled':'disabled';
  const latest=[utc(records?.latest_created),utc(records?.latest_updated)].filter(Boolean).sort().pop()??null;
  let summary;
  if(count>0)summary=`${count} Health Connect record(s) are stored for this account. Read them with get_health_connect.`;
  else if(tokenState==='active')summary='An ingest token is issued, but no Health Connect records are stored for this account yet. '+
    'A token is only a credential: data arrives only when the phone app sends supported records with it.';
  else summary='No Health Connect records are stored for this account.';
  return {
    as_of:new Date(now).toISOString(),
    seat_role:seat_role??'unknown',
    seat_role_source,
    role_boundaries:boundaries(seat_role,owner),
    whoop_connected:roleRow===UNREAD?'unknown':!!roleRow,
    health_connect:{
      phone_ingest_feature:flag,
      ingest_token:tokenState,
      token_issued_at:token?utc(token.created_at):null,
      // Set when a request authenticated with the active token opened a new
      // 15-minute rate window. It says nothing about whether records were stored.
      latest_authenticated_delivery_window_at:token?utc(token.window_started_at):null,
      records_stored:count,
      latest_record_stored_at:latest,
      storage_consent:consent?(consent.withdrawn_at?'withdrawn':'granted'):'none',
      summary,
      evidence:'Counts and timestamps for this account only, read at as_of. No record content.',
      not_verifiable_here:['Whether the phone app has Health Connect permissions, ran a sync, or which types it sent.',
        'The response the phone app received for a delivery. An accepted delivery can store zero records.']
    },
    // Same seat class the limiter uses: whoop_connections.seat_role. Without a
    // connection row no WHOOP request is made, so no budget applies.
    request_budget:!memberLimitEnabled(env)?{state:'disabled'}:roleRow===UNREAD?{state:'unknown'}:!roleRow?
      {state:'not_applicable',reason:'No WHOOP connection, so no WHOOP requests are made.'}:
      {state:'enabled',...memberLimits(env)[role==='developer'?'developer':'public']}
  };
}
export const ISSUE_GUIDANCE=Object.freeze({
  // Scoped to this call: issuing or replacing a token never delivers data.
  this_call_delivered_data:false,
  next_step:'Enter header_name and header_value in the phone app, then let it sync. Issuing this token does not mean any data has arrived. Records already stored for this account are unchanged.',
  verify_with:'get_capabilities account.health_connect.records_stored, or get_health_connect',
  note:'A delivery can be accepted and still store zero records, for example when it has no supported types or permitted data.'
});
