// Account-wide Workers AI neuron budget for the current UTC day.
// The read-only token is the Worker secret AI_ACCOUNT_ANALYTICS_TOKEN
// (Account Analytics Read). The account id is AI_ANALYTICS_ACCOUNT_ID.
// Neither value is committed. A failed or stale read fails closed.
// ANALYTICS_STALE_MS is the oldest analytics sample we will trust. A newer
// sample still misses local reservations made after that sample, so those
// reservations are added. If the sample has no time, the ceiling uses the
// max of the analytics total and this Worker's local counter.
import {GLOBAL_SCOPE} from "./ai-quota.mjs";

export const ACCOUNT_NEURON_LIMIT=10000;
export const ACCOUNT_SAFETY_MARGIN=500;
export const ANALYTICS_CACHE_MS=3*60*1000;
export const ANALYTICS_STALE_MS=10*60*1000;
export const ANALYTICS_TOKEN_SECRET="AI_ACCOUNT_ANALYTICS_TOKEN";
export const ANALYTICS_ACCOUNT_ID="AI_ANALYTICS_ACCOUNT_ID";
const ANALYTICS_URL="https://api.cloudflare.com/client/v4/graphql";
const ANALYTICS_TIMEOUT_MS=2000;
const NEURON_QUERY=`query AccountNeurons($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiInferenceAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [datetime_DESC]
      ) {
        dimensions { datetime }
        sum { neurons }
      }
    }
  }
}`;
const READ_LOCAL=`SELECT used FROM ai_usage WHERE day = ?1 AND scope = ?2`;
const READ_SNAPSHOT=`SELECT neurons, local_used, fetched_at, recent_local FROM ai_account_snapshot WHERE day = ?1`;
const UPSERT_SNAPSHOT=`INSERT INTO ai_account_snapshot(day, neurons, local_used, fetched_at, recent_local)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(day) DO UPDATE SET
  neurons = excluded.neurons,
  local_used = excluded.local_used,
  fetched_at = excluded.fetched_at,
  recent_local = excluded.recent_local`;
const SUM_RECENT=`SELECT COALESCE(SUM(amount),0) AS recent FROM ai_usage_event
WHERE day = ?1 AND at_ms > ?2 AND at_ms <= ?3`;

export function accountCeiling(neurons,snapshotLocal,recentLocal=0){
  if(!Number.isSafeInteger(neurons)||neurons<0)return null;
  if(!Number.isSafeInteger(snapshotLocal)||snapshotLocal<0)return null;
  if(!Number.isSafeInteger(recentLocal)||recentLocal<0)return null;
  const accounted=neurons+recentLocal;
  if(!Number.isSafeInteger(accounted))return null;
  // max keeps a local counter that analytics has not caught yet.
  const basis=Math.max(accounted,snapshotLocal);
  const cap=ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN-basis+snapshotLocal;
  return Number.isSafeInteger(cap)?cap:null;
}
function validDay(day){
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  const parsed=Date.parse(day+"T00:00:00Z");
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===day;
}
function dayWindow(day){
  const startMs=Date.parse(day+"T00:00:00Z");
  const end=new Date(startMs+86400000).toISOString().replace(".000Z","Z");
  return {start:day+"T00:00:00Z",end};
}
function configured(env){
  const accountId=env?.[ANALYTICS_ACCOUNT_ID];
  const token=env?.[ANALYTICS_TOKEN_SECRET];
  if(typeof accountId!=="string"||!/^[a-f0-9]{32}$/i.test(accountId))return null;
  if(typeof token!=="string"||token.length<20||token.length>4096||/\s/.test(token))return null;
  return {accountId,token};
}
function asNeurons(value){
  if(typeof value!=="number"||!Number.isFinite(value)||value<0)return null;
  const neurons=Math.ceil(value);
  return Number.isSafeInteger(neurons)?neurons:null;
}
function sampleEnd(group){
  const raw=group?.dimensions?.datetime;
  if(typeof raw!=="string")return null;
  const parsed=Date.parse(raw);
  return Number.isFinite(parsed)?parsed:null;
}
export function analyticsSample(body){
  if(!body||typeof body!=="object")return null;
  if(Array.isArray(body.errors)&&body.errors.length>0)return null;
  const accounts=body.data?.viewer?.accounts;
  if(!Array.isArray(accounts)||accounts.length===0)return null;
  let total=0,endMs=null;
  for(const account of accounts){
    const groups=account?.aiInferenceAdaptiveGroups;
    if(!Array.isArray(groups))return null;
    for(const group of groups){
      const neurons=group?.sum?.neurons;
      if(typeof neurons!=="number"||!Number.isFinite(neurons)||neurons<0)return null;
      total+=neurons;
      if(!Number.isFinite(total))return null;
      const end=sampleEnd(group);
      if(end!=null&&(endMs==null||end>endMs))endMs=end;
    }
  }
  const neurons=asNeurons(total);
  return neurons==null?null:{neurons,endMs};
}
export function neuronsFromAnalyticsBody(body){
  const sample=analyticsSample(body);
  return sample?sample.neurons:null;
}
function reportedNeurons(result){
  if(!result||typeof result!=="object")return null;
  return asNeurons(result.neurons);
}
async function readRow(db,sql,binds){
  const row=await db.prepare(sql).bind(...binds).first();
  return row??null;
}
async function localUsed(db,day){
  const row=await readRow(db,READ_LOCAL,[day,GLOBAL_SCOPE]);
  if(!row)return 0;
  if(!Number.isSafeInteger(row.used)||row.used<0)return null;
  return row.used;
}
function snapshotOf(row,now){
  if(!row)return null;
  const neurons=asNeurons(row.neurons);
  if(neurons==null||row.neurons!==neurons)return null;
  if(!Number.isSafeInteger(row.local_used)||row.local_used<0)return null;
  if(!Number.isSafeInteger(row.fetched_at))return null;
  if(!Number.isSafeInteger(row.recent_local)||row.recent_local<0)return null;
  const age=now-row.fetched_at;
  return {neurons,local_used:row.local_used,fetched_at:row.fetched_at,recent_local:row.recent_local,age};
}
function reportedSample(result){
  const neurons=reportedNeurons(result);
  if(neurons==null)return null;
  if(result.end==null)return {neurons,endMs:null};
  const endMs=Date.parse(result.end);
  if(!Number.isFinite(endMs))return null;
  return {neurons,endMs};
}
async function queryNeurons(env,{accountId,token,start,end}){
  // Test hooks only. A Wrangler var is a string, so it cannot take either path.
  if(typeof env.AI_ANALYTICS_QUERY==="function")
    return reportedSample(await env.AI_ANALYTICS_QUERY({accountId,start,end}));
  const fetchImpl=typeof env.AI_ANALYTICS_FETCH==="function"?env.AI_ANALYTICS_FETCH:globalThis.fetch;
  if(typeof fetchImpl!=="function")return null;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ANALYTICS_TIMEOUT_MS);
  try{
    const response=await fetchImpl(ANALYTICS_URL,{
      method:"POST",
      redirect:"error",
      signal:controller.signal,
      headers:{
        "content-type":"application/json",
        accept:"application/json",
        authorization:"Bearer "+token
      },
      body:JSON.stringify({
        query:NEURON_QUERY,
        variables:{accountTag:accountId,start,end}
      })
    });
    if(!response||response.ok!==true||typeof response.json!=="function")return null;
    return analyticsSample(await response.json());
  }catch{
    return null;
  }finally{
    clearTimeout(timer);
  }
}
function budgetFrom(neurons,snapshotLocal,recentLocal){
  const accountCap=accountCeiling(neurons,snapshotLocal,recentLocal);
  if(accountCap==null)return {ok:false};
  return {ok:true,neurons,snapshotLocal,recentLocal,accountCap};
}
async function reservationsSince(db,day,endMs,readAt){
  if(endMs==null)return 0;
  const row=await readRow(db,SUM_RECENT,[day,endMs,readAt]);
  const recent=Number(row?.recent??0);
  if(!Number.isSafeInteger(recent)||recent<0)return null;
  return recent;
}
export async function loadAccountBudget(db,env,{day,now}={}){
  try{
    const config=configured(env);
    if(!config||!db||typeof db.prepare!=="function")return {ok:false};
    if(!validDay(day)||!Number.isSafeInteger(now))return {ok:false};
    const cached=snapshotOf(await readRow(db,READ_SNAPSHOT,[day]),now);
    if(cached&&cached.age>=0&&cached.age<=ANALYTICS_CACHE_MS){
      const hit=budgetFrom(cached.neurons,cached.local_used,cached.recent_local);
      if(hit.ok)return {...hit,cached:true};
    }
    // Read our counter before the network call so reservations made while
    // analytics is in flight stay outside the snapshot and are not dropped.
    const snapshotLocal=await localUsed(db,day);
    if(snapshotLocal==null)return {ok:false};
    const readAt=Date.now();
    const window=dayWindow(day);
    const sample=await queryNeurons(env,{...config,...window});
    if(!sample)return {ok:false};
    // A sample older than ANALYTICS_STALE_MS is not a safe ceiling.
    if(sample.endMs!=null&&now-sample.endMs>ANALYTICS_STALE_MS)return {ok:false};
    const recent=await reservationsSince(db,day,sample.endMs,readAt);
    if(recent==null)return {ok:false};
    const written=await db.prepare(UPSERT_SNAPSHOT).bind(day,sample.neurons,snapshotLocal,now,recent).run();
    if(!written||written.success===false)return {ok:false};
    return {...budgetFrom(sample.neurons,snapshotLocal,recent),cached:false};
  }catch{
    return {ok:false};
  }
}
