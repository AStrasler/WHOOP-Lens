// Member parity tools (Android Home and Account & data equivalents). Read-only, caller-scoped:
// every query binds the verified user ID; no tool argument can name another member.
import {activeMembership,connectionStatus} from './storage.mjs';

const noArgs=Object.freeze({type:'object',properties:{},additionalProperties:false});
const readOnly=Object.freeze({readOnlyHint:true,destructiveHint:false,idempotentHint:true});

export const dashboardOverviewTool=Object.freeze({
  name:'get_dashboard_overview',
  description:'Dashboard snapshot for the signed-in member, matching the Android Home screen: latest WHOOP recovery (score, HRV, resting heart rate, SpO2, skin temperature), latest cycle strain, latest main (non-nap) sleep, and the Health Connect step total for the latest stored local day, summed from that day\'s step records. Every value carries its source, measured time and a stale flag. Missing values are reported as missing and are never filled from another source. Read-only.',
  inputSchema:noArgs,
  annotations:{...readOnly,openWorldHint:true}
});
export const accountDataSummaryTool=Object.freeze({
  name:'get_account_data_summary',
  description:'What WhoopLens stores for the signed-in member, by category: record counts, consent and connection states, and the self-service tool that revokes or deletes each one. Counts and states only; no health values. Read-only.',
  inputSchema:noArgs,
  annotations:{...readOnly,openWorldHint:false}
});
export const memberOverviewTools=Object.freeze([dashboardOverviewTool,accountDataSummaryTool]);
export const isMemberOverviewTool=name=>memberOverviewTools.some(t=>t.name===name);
export function memberOverviewArguments(name,args){
  if(!isMemberOverviewTool(name)||!args||typeof args!=='object'||Array.isArray(args))return null;
  return Object.keys(args).length===0?{}:null;
}

const DAY=86400000;
const iso=value=>{const t=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(t)?new Date(t).toISOString():null;};
const num=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
function measured(value,unit,at,now,staleAfter){
  if(value===null)return {value:null,unit,missing:true};
  const time=iso(at);
  return {value,unit,measured_at:time,stale:time?now-Date.parse(time)>staleAfter:true,missing:false};
}

// WHOOP gives each record's local offset as "+hh:mm" / "-hh:mm".
function whoopOffset(record){
  const m=/^([+-])(\d{2}):(\d{2})$/.exec(record?.timezone_offset??'');
  return m?(m[1]==='-'?-1:1)*(Number(m[2])*3600000+Number(m[3])*60000):null;
}
const countOf=json=>{try{return num(JSON.parse(json??'null')?.count);}catch{return null;}};
const STEP_DAY_ROWS=2000;

// Health Connect step records are intervals (the phone sends 15-minute buckets), so the
// daily figure is the sum of the latest local day's records, not the latest record.
async function dailySteps(db,userId,whoopOffsetMs,now){
  const latest=await db.prepare("SELECT local_date,observed_at FROM health_connect_records WHERE user_id=?1 AND metric='steps_daily' ORDER BY COALESCE(observed_at,local_date) DESC LIMIT 1").bind(userId).first();
  if(!latest)return null;
  const offset=whoopOffsetMs??0;
  const basis=latest.local_date?'record_local_date':whoopOffsetMs!==null?'whoop_timezone_offset':'utc';
  const latestAt=Date.parse(latest.observed_at);
  const day=latest.local_date??(Number.isFinite(latestAt)?new Date(latestAt+offset).toISOString().slice(0,10):null);
  if(!day)return null;
  const from=new Date(Date.parse(day+'T00:00:00Z')-offset).toISOString();
  const to=new Date(Date.parse(from)+DAY).toISOString();
  const {results=[]}=await db.prepare("SELECT payload_json,observed_at,ended_at FROM health_connect_records WHERE user_id=?1 AND metric='steps_daily' AND (local_date=?2 OR (local_date IS NULL AND observed_at>=?3 AND observed_at<?4)) LIMIT ?5")
    .bind(userId,day,from,to,STEP_DAY_ROWS).all();
  // Phone ingest and a file import can both hold the same day; sum one source only.
  const bySource={};
  for(const row of results){
    const count=countOf(row.payload_json);if(count===null)continue;
    let ingest='file_import';try{ingest=JSON.parse(row.payload_json)?.ingest==='hc_webhook'?'phone_ingest':'file_import';}catch{}
    const b=bySource[ingest]??={sum:0,records:0,last:null};
    b.sum+=count;b.records+=1;
    const end=iso(row.ended_at)??iso(row.observed_at);if(end&&(!b.last||end>b.last))b.last=end;
  }
  const used=bySource.phone_ingest?'phone_ingest':bySource.file_import?'file_import':null;
  if(!used)return {value:null,unit:'steps',missing:true,local_date:day};
  const b=bySource[used];
  const today=new Date(now+offset).toISOString().slice(0,10);
  return {...measured(b.sum,'steps',b.last,now,1.5*DAY),local_date:day,day_basis:basis,partial_day:day===today,
    records_summed:b.records,ingest:used,
    note:'Sum of the stored Health Connect step records for this local day. It can differ from the phone\'s own total when several apps record overlapping steps.'+
      (bySource.phone_ingest&&bySource.file_import?' A file import for the same day was not added, to avoid counting steps twice.':'')+
      (results.length>=STEP_DAY_ROWS?' The day has more records than this summary reads, so the total may be low.':'')};
}

export async function buildDashboardOverview({db,userId,env,whoopRequest,now=Date.now()}){
  if(!await activeMembership(db,userId))throw Error('Not authorized');
  const connected=(await connectionStatus(db,userId)).connected;
  const whoop={source:'whoop',source_authority:'authoritative',connected,unavailable:[]};
  async function latest(resource,limit){
    if(!connected)return null;
    try{const data=await whoopRequest(db,userId,resource,env,{limit});return Array.isArray(data?.records)?data.records:null;}
    catch{whoop.unavailable.push(resource);return null;}
  }
  // Sequential reads keep within the member's WHOOP request budget.
  const recoveries=await latest('recovery',1);
  const cycles=await latest('cycles',1);
  const sleeps=await latest('sleep',5);
  const r=recoveries?.[0], rs=r?.score_state==='SCORED'?r.score:null;
  const recoveryAt=r?.updated_at??r?.created_at;
  whoop.recovery=r?{
    score_state:r.score_state??'unknown',
    recovery_score:measured(num(rs?.recovery_score),'%',recoveryAt,now,1.5*DAY),
    hrv_rmssd:measured(num(rs?.hrv_rmssd_milli),'ms',recoveryAt,now,1.5*DAY),
    resting_heart_rate:measured(num(rs?.resting_heart_rate),'bpm',recoveryAt,now,1.5*DAY),
    spo2:measured(num(rs?.spo2_percentage),'%',recoveryAt,now,1.5*DAY),
    skin_temperature:measured(num(rs?.skin_temp_celsius),'°C',recoveryAt,now,1.5*DAY)
  }:{missing:true};
  const c=cycles?.[0];
  whoop.strain=c?{
    cycle_open:!c.end,
    note:c.end?'Completed cycle.':'Open cycle: strain is still accumulating and is not a final daily total.',
    strain:measured(c.score_state==='SCORED'?num(c.score?.strain):null,'/ 21',c.end??c.start,now,1.5*DAY),
    average_heart_rate:measured(c.score_state==='SCORED'?num(c.score?.average_heart_rate):null,'bpm',c.end??c.start,now,1.5*DAY)
  }:{missing:true};
  const s=sleeps?.find(x=>x&&x.nap!==true);
  const st=s?.score_state==='SCORED'?s.score:null;
  const stages=st?.stage_summary;
  const asleep=stages?[stages.total_light_sleep_time_milli,stages.total_slow_wave_sleep_time_milli,stages.total_rem_sleep_time_milli]
    .every(v=>Number.isFinite(v))?Math.round((stages.total_light_sleep_time_milli+stages.total_slow_wave_sleep_time_milli+stages.total_rem_sleep_time_milli)/60000):null:null;
  whoop.sleep=s?{
    start:iso(s.start),end:iso(s.end),
    performance:measured(num(st?.sleep_performance_percentage),'%',s.end,now,1.5*DAY),
    asleep_minutes:measured(asleep,'min',s.end,now,1.5*DAY),
    respiratory_rate:measured(num(st?.respiratory_rate),'rpm',s.end,now,1.5*DAY)
  }:{missing:true};
  let health_connect;
  try{
    const daily_steps=await dailySteps(db,userId,whoopOffset(cycles?.[0])??whoopOffset(s),now);
    health_connect=daily_steps?{source:'health_connect',source_authority:'supplementary',daily_steps}:
      {source:'health_connect',source_authority:'supplementary',daily_steps:{value:null,missing:true},
       note:'No Health Connect step records are stored for this account.'};
  }catch{health_connect={source:'health_connect',unavailable:true,note:'Health Connect records could not be read right now.'};}
  return {as_of:new Date(now).toISOString(),whoop,health_connect,
    notes:[connected?null:'WHOOP is not connected for this account. Use connect_whoop to connect; no WHOOP values are shown.',
      whoop.unavailable.length?'Some WHOOP reads failed right now ('+whoop.unavailable.join(', ')+'); those values are missing, not zero.':null,
      'Health Connect values are supplementary and never replace WHOOP measurements.'].filter(Boolean)};
}

// Each probe reads one count or state for the verified member only.
const PROBES=Object.freeze([
  ['whoop_connection','SELECT seat_role,updated_at FROM whoop_connections WHERE user_id=?1',
    r=>({connected:!!r,seat_role:r?.seat_role??null,updated_at:iso(r?.updated_at)}),'disconnect_whoop'],
  ['health_connect_records','SELECT COUNT(*) AS n FROM health_connect_records WHERE user_id=?1',r=>({stored:Number(r?.n??0)}),'withdraw_health_connect_import'],
  ['health_connect_consent',"SELECT granted_at,withdrawn_at FROM health_import_consent WHERE user_id=?1 AND purpose='health_connect_file'",
    r=>({state:!r?'none':r.withdrawn_at?'withdrawn':r.granted_at?'granted':'none'}),'pause_companion_sync'],
  ['health_connect_ingest_tokens','SELECT SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active FROM health_connect_ingest_tokens WHERE user_id=?1',
    r=>({active:Number(r?.active??0)}),'revoke_health_connect_ingest_token'],
  ['companion_sync','SELECT last_sync_at FROM companion_sync_status WHERE user_id=?1',r=>({last_sync_at:iso(r?.last_sync_at)}),'pause_companion_sync'],
  ['flare_consent','SELECT storage,analysis,updated_at FROM flare_consent WHERE user_id=?1',
    r=>({storage:r?Number(r.storage)===1:false,analysis:r?Number(r.analysis)===1:false}),'set_flare_consent'],
  ['flare_journal','SELECT COUNT(*) AS n FROM flare_journal WHERE user_id=?1',r=>({entries:Number(r?.n??0)}),'withdraw_flare_journal'],
  ['life_schedule','SELECT life_schedule,updated_at FROM member_life_schedule WHERE user_id=?1',
    r=>({selection:r?.life_schedule??null,explicit:!!r,updated_at:iso(r?.updated_at)}),'set_life_schedule'],
  ['notion','SELECT updated_at FROM notion_accounts WHERE user_id=?1 AND credentials IS NOT NULL',r=>({connected:!!r}),'disconnect_notion'],
  ['samsung_health_records','SELECT COUNT(*) AS n FROM samsung_health_records WHERE user_id=?1',r=>({stored:Number(r?.n??0)}),null],
  ['medical_context','SELECT COUNT(*) AS n FROM medical_context WHERE user_id=?1',r=>({stored:Number(r?.n??0)}),null],
  ['issue_reports','SELECT COUNT(*) AS n FROM issue_reports WHERE user_id=?1',r=>({submitted:Number(r?.n??0)}),null]
]);
export async function buildAccountDataSummary({db,userId,now=Date.now()}){
  if(!await activeMembership(db,userId))throw Error('Not authorized');
  const categories={};
  for(const [name,sql,shape,tool] of PROBES){
    try{
      const row=await db.prepare(sql).bind(userId).first();
      categories[name]={...shape(row),self_service:tool};
    }catch{categories[name]={state:'unavailable',note:'Not readable right now (or not set up on this server).',self_service:tool};}
  }
  return {as_of:new Date(now).toISOString(),categories,
    self_service_note:'Tools named in self_service change or delete that category for this account only; destructive ones need their own explicit confirmation. Categories with self_service null have no MCP deletion: use the privacy request page https://www.whooplens.tech/privacy/.',
    phone_side:'Data on the phone (Health Connect permissions, local caches, Direct BLE readings, widgets) is controlled in the Android app and Android settings, not here.'};
}
