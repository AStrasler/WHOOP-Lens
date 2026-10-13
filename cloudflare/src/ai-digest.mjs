// On-demand weekly digest for the signed-in user. No send, no schedule.
import {aiSummaryEnabled,attachSummary,observationDate} from "./ai-summary.mjs";

export function weeklyDigestEnabled(env){return env?.WEEKLY_DIGEST_ENABLED==="true";}
export function parseDigestEnd(value,now=Date.now()){
  if(value==null){
    const date=new Date(now);
    return Number.isNaN(date.getTime())?null:date.toISOString().slice(0,10);
  }
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const parsed=Date.parse(value+"T00:00:00Z");
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value?value:null;
}
function shiftDay(iso,days){
  return new Date(Date.parse(iso+"T00:00:00Z")+days*86400000).toISOString().slice(0,10);
}
export function digestPeriod(end){
  return {start:shiftDay(end,-6),end};
}
function inRange(record,start,end){
  const date=observationDate(record);
  return !!date&&date>=start&&date<=end;
}
async function onePage(whoopRequest,db,userId,env,resource){
  const page=await whoopRequest(db,userId,resource,env,{limit:25,next_token:null,auto_page:false});
  const records=Array.isArray(page?.records)?page.records:[];
  return records.filter(row=>row&&typeof row==="object"&&!Array.isArray(row)).slice(0,25);
}
export async function buildWeeklyDigest({db,userId,env,whoopRequest,now,end}){
  const day=parseDigestEnd(end,now);
  if(!day)return {ok:false};
  const period=digestPeriod(day);
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
  return {
    ok:true,
    kind:"weekly_digest",
    period,
    recovery_count:recoveryRecords.length,
    sleep_count:sleepRecords.length,
    summary:summarized?.summary??null
  };
}
