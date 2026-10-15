// Pulled weekly digest for the signed-in user. No send, no schedule.
// Cache keys are per account/week/output mode. Switching a feature off cannot
// replay an earlier digest containing experimental stress results.
// A repeat with unchanged output mode does not call the model again.
import {aiSummaryEnabled,stressEstimateEnabled,attachSummary,collectHistoryPages} from "./ai-summary.mjs";
import {userScope,utcDay} from "./ai-quota.mjs";

const PENDING_MS=30000;
const MAX_BODY=200000;
const CLAIM=`INSERT INTO ai_weekly_digest(scope, week_ending, state, body, created_at)
VALUES (?1, ?2, 'pending', NULL, ?3)
ON CONFLICT(scope, week_ending) DO NOTHING`;
const READ=`SELECT state, body, created_at FROM ai_weekly_digest
WHERE scope = ?1 AND week_ending = ?2`;
const SAVE=`UPDATE ai_weekly_digest SET state = 'ready', body = ?1
WHERE scope = ?2 AND week_ending = ?3 AND state = 'pending'`;
const RELEASE=`DELETE FROM ai_weekly_digest
WHERE scope = ?1 AND week_ending = ?2 AND state = 'pending'`;
const RECLAIM=`UPDATE ai_weekly_digest SET created_at = ?1
WHERE scope = ?2 AND week_ending = ?3 AND state = 'pending' AND created_at <= ?4`;

export function weeklyDigestEnabled(env){return env?.WEEKLY_DIGEST_ENABLED==="true";}
// Versioned scope leaves historical, flag-unaware cached rows unreachable. The
// mode separates model/template output and experimental stress on/off without a
// D1 migration or mutation of cached health data. Same user/week stays cached.
export function digestCacheScope(userId,env){
  return `${userScope(userId)}:weekly-v2:${aiSummaryEnabled(env)?"model":"template"}:${stressEstimateEnabled(env)?"stress":"no-stress"}`;
}
export function parseWeekEnding(value){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const parsed=Date.parse(value+"T00:00:00Z");
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value?value:null;
}
function shiftDay(iso,days){
  return new Date(Date.parse(iso+"T00:00:00Z")+days*86400000).toISOString().slice(0,10);
}
// Monday through Sunday, UTC. A week is complete only after its Sunday has ended,
// so the default is the latest Sunday strictly before today.
export function mostRecentCompleteWeekEnding(now=Date.now()){
  const today=utcDay(now);
  if(!today)return null;
  const dow=new Date(Date.parse(today+"T00:00:00Z")).getUTCDay();
  return shiftDay(today,dow===0?-7:-dow);
}
function weekClock(now,env){
  if(typeof now==="number"&&Number.isFinite(now))return now;
  const hooked=env?.WEEKLY_DIGEST_NOW;
  if(typeof hooked==="number"&&Number.isFinite(hooked))return hooked;
  return Date.now();
}
export function digestPeriod(end){
  return {start:shiftDay(end,-6),end};
}
function validUser(userId){
  return typeof userId==="string"&&userId.length>0&&userId.length<=80&&
    userId!=="global"&&!/[\u0000-\u001f]/.test(userId);
}
function changesOf(result){
  const changes=result?.meta?.changes;
  return typeof changes==="number"?changes:-1;
}
function digestView(summary,period,weekEnding){
  if(!summary||typeof summary.text!=="string"||summary.text.length===0)return null;
  if(!summary.chart_data||typeof summary.chart_data!=="object"||Array.isArray(summary.chart_data))return null;
  if(!Array.isArray(summary.insights)||summary.insights.some(line=>typeof line!=="string"))return null;
  if(summary.status!=="model"&&summary.status!=="template")return null;
  return {
    kind:"weekly_digest",
    week_ending:weekEnding,
    period,
    text:summary.text,
    chart_data:summary.chart_data,
    insights:summary.insights,
    status:summary.status
  };
}
function readyDigest(row,weekEnding){
  if(!row||row.state!=="ready"||typeof row.body!=="string"||row.body.length>MAX_BODY)return null;
  let parsed;
  try{parsed=JSON.parse(row.body);}catch{return null;}
  if(!parsed||parsed.kind!=="weekly_digest"||parsed.week_ending!==weekEnding)return null;
  if(!parsed.period||parsed.period.start!==shiftDay(weekEnding,-6)||parsed.period.end!==weekEnding)return null;
  return digestView(parsed,parsed.period,weekEnding);
}
async function claimWeek(db,scope,weekEnding){
  const nowMs=Date.now();
  const inserted=await db.prepare(CLAIM).bind(scope,weekEnding,nowMs).run();
  if(changesOf(inserted)===1)return {status:"owner"};
  const row=await db.prepare(READ).bind(scope,weekEnding).first();
  if(row?.state==="ready"){
    const cached=readyDigest(row,weekEnding);
    return cached?{status:"ready",cached}:{status:"invalid"};
  }
  if(row?.state==="pending"&&Number.isSafeInteger(row.created_at)&&nowMs-row.created_at>=PENDING_MS){
    const reclaimed=await db.prepare(RECLAIM).bind(nowMs,scope,weekEnding,nowMs-PENDING_MS).run();
    if(changesOf(reclaimed)===1)return {status:"owner"};
  }
  return {status:"busy"};
}
async function generateDigest({db,userId,env,whoopRequest,now,period,weekEnding}){
  // A morning recovery can belong to a sleep whose start is the previous UTC
  // day. Late-evening US starts are often already on the recovery's UTC day;
  // the extra day is only so that sleep is still fetched. Pairing uses ids.
  const sleepStart=shiftDay(period.start,-1);
  const ctx={db,userId,env,whoopRequest};
  const recovery=typeof whoopRequest==="function"
    ?await collectHistoryPages(whoopRequest,ctx,"recovery",{start:period.start,end:period.end})
    :{records:[],complete:false};
  const sleep=typeof whoopRequest==="function"
    ?await collectHistoryPages(whoopRequest,ctx,"sleep",{start:sleepStart,end:period.end})
    :{records:[],complete:false};
  const covered=recovery.complete&&sleep.complete&&recovery.records.length+sleep.records.length>0;
  const data={records:[...sleep.records,...recovery.records],next_token:null};
  const summariesOn=aiSummaryEnabled(env);
  const modelEnv=summariesOn?env:{...env,AI:undefined};
  const summarized=await attachSummary(data,{db,userId,env:modelEnv,tool:"get_recovery",now,whoopRequest});
  const view=digestView(summarized?.summary,period,weekEnding);
  if(!view)return null;
  // A template while summaries are on is a fallback (quota, analytics, or the
  // model). Caching it would keep that fallback for the whole week.
  // The outer weekly history may be complete while the extra physiological
  // baseline fetch is rate-limited or only partially retrieved. Do not persist
  // transient stress failures as a ready digest: retry on the next request.
  // A stable "insufficient_baseline" with fully fetched history may be cached.
  const chart=view.chart_data?.stress_estimate;
  const stressReady=!stressEstimateEnabled(env)||
    (chart!=null&&chart.reason!=="rate_limited"&&chart.reason!=="incomplete_history"&&
     chart.history?.complete===true);
  const cacheable=covered&&stressReady&&(summariesOn?view.status==="model":view.status==="template");
  return {view,cacheable};
}
export async function buildWeeklyDigest({db,userId,env,whoopRequest,now,weekEnding}){
  const day=weekEnding==null?mostRecentCompleteWeekEnding(weekClock(now,env)):parseWeekEnding(weekEnding);
  if(!day||!validUser(userId)||!db||typeof db.prepare!=="function")return {ok:false};
  const period=digestPeriod(day);
  const scope=digestCacheScope(userId,env);
  let owned=false,saved=false;
  try{
    const claim=await claimWeek(db,scope,day);
    if(claim.status==="ready")return {ok:true,...claim.cached,cached:true};
    if(claim.status!=="owner")return {ok:false};
    owned=true;
    const generated=await generateDigest({db,userId,env,whoopRequest,now:weekClock(now,env),period,weekEnding:day});
    if(!generated)return {ok:false};
    if(generated.cacheable){
      const body=JSON.stringify(generated.view);
      if(body.length>MAX_BODY)return {ok:false};
      const written=await db.prepare(SAVE).bind(body,scope,day).run();
      if(changesOf(written)!==1)return {ok:false};
      saved=true;
    }
    return {ok:true,...generated.view,cached:false};
  }catch{
    return {ok:false};
  }finally{
    if(owned&&!saved){
      try{await db.prepare(RELEASE).bind(scope,day).run();}catch{/* the next pull can claim the week */}
    }
  }
}
