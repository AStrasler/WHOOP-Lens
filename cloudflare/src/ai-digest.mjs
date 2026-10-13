// Pulled weekly digest for the signed-in user. No send, no schedule.
// One cached digest per account per week. A repeat does not call the model again.
import {aiSummaryEnabled,attachSummary,observationDate} from "./ai-summary.mjs";
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
function inRange(record,start,end){
  const date=observationDate(record);
  return !!date&&date>=start&&date<=end;
}
function changesOf(result){
  const changes=result?.meta?.changes;
  return typeof changes==="number"?changes:-1;
}
function digestView(summary,period,weekEnding){
  if(!summary||typeof summary.text!=="string"||summary.text.length===0)return null;
  if(!summary.chart_data||typeof summary.chart_data!=="object"||Array.isArray(summary.chart_data))return null;
  if(!Array.isArray(summary.insights)||summary.insights.some(line=>typeof line!=="string"))return null;
  return {
    kind:"weekly_digest",
    week_ending:weekEnding,
    period,
    text:summary.text,
    chart_data:summary.chart_data,
    insights:summary.insights
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
async function onePage(whoopRequest,db,userId,env,resource){
  const page=await whoopRequest(db,userId,resource,env,{limit:25,next_token:null,auto_page:false});
  const records=Array.isArray(page?.records)?page.records:[];
  return records.filter(row=>row&&typeof row==="object"&&!Array.isArray(row)).slice(0,25);
}
async function generateDigest({db,userId,env,whoopRequest,now,period,weekEnding}){
  const sleepStart=shiftDay(period.start,-1);
  let recovery=[],sleep=[];
  if(typeof whoopRequest==="function"){
    recovery=await onePage(whoopRequest,db,userId,env,"recovery");
    sleep=await onePage(whoopRequest,db,userId,env,"sleep");
  }
  const recoveryRecords=recovery.filter(row=>inRange(row,period.start,period.end));
  const sleepRecords=sleep.filter(row=>inRange(row,sleepStart,period.end));
  const data={records:[...sleepRecords,...recoveryRecords],next_token:null};
  const modelEnv=aiSummaryEnabled(env)?env:{...env,AI:undefined};
  const summarized=await attachSummary(data,{db,userId,env:modelEnv,tool:"get_recovery",now});
  return digestView(summarized?.summary,period,weekEnding);
}
export async function buildWeeklyDigest({db,userId,env,whoopRequest,now,weekEnding}){
  const day=weekEnding==null?mostRecentCompleteWeekEnding(weekClock(now,env)):parseWeekEnding(weekEnding);
  if(!day||!validUser(userId)||!db||typeof db.prepare!=="function")return {ok:false};
  const period=digestPeriod(day);
  const scope=userScope(userId);
  let owned=false,saved=false;
  try{
    const claim=await claimWeek(db,scope,day);
    if(claim.status==="ready")return {ok:true,...claim.cached,cached:true};
    if(claim.status!=="owner")return {ok:false};
    owned=true;
    const view=await generateDigest({db,userId,env,whoopRequest,now:weekClock(now,env),period,weekEnding:day});
    if(!view)return {ok:false};
    const body=JSON.stringify(view);
    if(body.length>MAX_BODY)return {ok:false};
    const written=await db.prepare(SAVE).bind(body,scope,day).run();
    if(changesOf(written)!==1)return {ok:false};
    saved=true;
    return {ok:true,...view,cached:false};
  }catch{
    return {ok:false};
  }finally{
    if(owned&&!saved){
      try{await db.prepare(RELEASE).bind(scope,day).run();}catch{/* the next pull can claim the week */}
    }
  }
}
