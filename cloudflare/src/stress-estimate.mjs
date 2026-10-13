// WHOOP Lens physiological stress estimate (wl-stress-v1). Issue #23 section 6.
// Deterministic, computed in the Worker from one user's already-authorized WHOOP
// recovery records (and that user's sleep records when available). It is our own
// derived estimate: not WHOOP's Stress Monitor, not clinically validated, and not
// a diagnosis. Pure functions; nothing here logs, stores, or fetches.

export const STRESS_NAME="WHOOP Lens experimental physiological stress estimate";
export const STRESS_LABEL="Experimental WHOOP Lens estimate. Not WHOOP's Stress Monitor. Not clinically validated. Not a diagnosis.";
export const STRESS_VERSION="wl-stress-v1";
export const BASELINE_DAYS=30;
export const MIN_BASELINE_DAYS=14;
const Z_CLIP=3;
const MAD_TO_SD=1.4826;

// Inputs, direction (+1: higher value means more physiological load), cluster,
// weight within the cluster, and a scale floor used when the baseline spread is
// 0 or tiny so one small change cannot produce an extreme score.
export const INPUTS=Object.freeze({
  hrv_rmssd:{label:"HRV (RMSSD)",unit:"millisecond",direction:-1,cluster:"autonomic",weight:0.6,floor:m=>Math.max(1,Math.abs(m)*0.05)},
  resting_heart_rate:{label:"Resting heart rate",unit:"bpm",direction:1,cluster:"autonomic",weight:0.4,floor:()=>1},
  sleep_performance:{label:"Sleep performance",unit:"percent",direction:-1,cluster:"sleep",weight:0.4,floor:()=>3},
  sleep_duration:{label:"Sleep duration",unit:"hour",direction:-1,cluster:"sleep",weight:0.35,floor:()=>0.25},
  sleep_efficiency:{label:"Sleep efficiency",unit:"percent",direction:-1,cluster:"sleep",weight:0.25,floor:()=>2},
  respiratory_rate:{label:"Respiratory rate",unit:"breaths per minute",direction:1,cluster:"respiratory",weight:1,floor:()=>0.3}
});
// Cluster weights. HRV and resting HR form one autonomic cluster so the two
// correlated signals share a single 0.6 budget instead of counting twice.
export const CLUSTERS=Object.freeze({autonomic:0.6,sleep:0.3,respiratory:0.1});
// Reported for context, never scored, with the reason.
export const EXCLUDED=Object.freeze({
  recovery_score:"WHOOP recovery is derived largely from HRV, resting heart rate and sleep, so scoring it would double count those inputs.",
  skin_temp:"WHOOP skin temperature has no single stress direction (it can move either way), so it is not scored."
});
export const BANDS=Object.freeze([
  {band:"low",max:35},{band:"typical",max:65},{band:"elevated",max:80},{band:"high",max:100}
]);
export const LIMITATIONS=Object.freeze([
  "This is the WHOOP Lens experimental physiological stress estimate, a derived daily index. It is not WHOOP's Stress Monitor and is not clinically validated.",
  "It compares each day with the same person's prior 30 days. 50 means typical for that person; higher values mean HRV, resting heart rate, sleep or respiratory rate moved in the direction usually linked with physiological load.",
  "WHOOP provides one value per day, with no intraday heart rate, so short events within a day are not visible.",
  "Training, illness, alcohol, travel and measurement noise can move the same inputs. The estimate does not identify a cause.",
  "Days without enough history (at least 14 scored days in the prior 30) are reported as insufficient instead of estimated."
]);

const DAY_MS=86400000;
const isNum=v=>typeof v==="number"&&Number.isFinite(v);
const round=(v,d=2)=>{const f=10**d;const r=Math.round(v*f)/f;return Object.is(r,-0)?0:r;};
function isoDay(value){
  if(typeof value!=="string")return null;
  const t=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+"T00:00:00Z":value);
  return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):null;
}
const shift=(day,n)=>new Date(Date.parse(day+"T00:00:00Z")+n*DAY_MS).toISOString().slice(0,10);
function idOf(v){
  if(typeof v==="string"&&/^[A-Za-z0-9-]{1,80}$/.test(v))return v;
  if(Number.isSafeInteger(v)&&v>=0)return String(v);
  return null;
}
function median(values){
  const s=values.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
function scored(record){
  return record&&typeof record==="object"&&record.score_state==="SCORED"&&
    record.score&&typeof record.score==="object"&&record.score.user_calibrating!==true;
}
// Recovery records: the day is the recovery's own date (cycle morning).
function recoveryRows(records){
  const byDay=new Map();
  let excluded=0;
  for(const r of records||[]){
    if(!scored(r)){excluded++;continue;}
    const day=isoDay(r.created_at)||isoDay(r.updated_at);
    if(!day){excluded++;continue;}
    const s=r.score;
    const row={day,cycle:idOf(r.cycle_id),sleep_id:idOf(r.sleep_id),
      hrv_rmssd:isNum(s.hrv_rmssd_milli)&&s.hrv_rmssd_milli>0?s.hrv_rmssd_milli:null,
      resting_heart_rate:isNum(s.resting_heart_rate)&&s.resting_heart_rate>0?s.resting_heart_rate:null,
      recovery_score:isNum(s.recovery_score)?s.recovery_score:null,
      skin_temp:isNum(s.skin_temp_celsius)?s.skin_temp_celsius:null};
    // One row per day: duplicates (overlapping pages, re-scored cycles) keep the
    // highest cycle id, so the result does not depend on page order.
    const prev=byDay.get(day);
    if(!prev||(row.cycle&&(!prev.cycle||Number(row.cycle)>Number(prev.cycle))))byDay.set(day,row);
  }
  return {rows:byDay,excluded};
}
function sleepRows(records){
  const byId=new Map();
  for(const r of records||[]){
    if(!scored(r)||r.nap===true)continue;
    const s=r.score,st=s.stage_summary||{};
    const asleep=[st.total_light_sleep_time_milli,st.total_slow_wave_sleep_time_milli,st.total_rem_sleep_time_milli];
    const id=idOf(r.id);
    if(!id||byId.has(id))continue;
    byId.set(id,{
      sleep_performance:isNum(s.sleep_performance_percentage)?s.sleep_performance_percentage:null,
      sleep_efficiency:isNum(s.sleep_efficiency_percentage)?s.sleep_efficiency_percentage:null,
      sleep_duration:asleep.every(isNum)?asleep.reduce((a,b)=>a+b,0)/3600000:null,
      respiratory_rate:isNum(s.respiratory_rate)&&s.respiratory_rate>0?s.respiratory_rate:null
    });
  }
  return byId;
}
// Joins one row per recovery day. Sleep joins only through the recovery's own
// sleep_id (the sleep that produced that cycle's recovery), never by calendar day,
// so time zones and late or split sleeps cannot attach the wrong night.
export function dailyInputs(recoveryRecords,sleepRecords){
  const {rows,excluded}=recoveryRows(recoveryRecords);
  const sleeps=sleepRows(sleepRecords);
  const out=new Map();
  for(const [day,r] of rows){
    const sleep=(r.sleep_id&&sleeps.get(r.sleep_id))||{};
    out.set(day,{day,hrv_rmssd:r.hrv_rmssd,resting_heart_rate:r.resting_heart_rate,
      sleep_performance:sleep.sleep_performance??null,sleep_duration:sleep.sleep_duration??null,
      sleep_efficiency:sleep.sleep_efficiency??null,respiratory_rate:sleep.respiratory_rate??null,
      recovery_score:r.recovery_score,skin_temp:r.skin_temp});
  }
  return {days:out,excluded};
}
const required=row=>row&&row.hrv_rmssd!=null&&row.resting_heart_rate!=null;
export function bandFor(value){
  for(const b of BANDS)if(value<b.max||b.max===100)return b.band;
  return "high";
}
function baselineFor(days,day,input){
  const values=[];
  for(let i=1;i<=BASELINE_DAYS;i++){
    const row=days.get(shift(day,-i));
    if(row&&required(row)&&row[input]!=null)values.push(row[input]);
  }
  if(!values.length)return null;
  const med=median(values);
  const mad=median(values.map(v=>Math.abs(v-med)))*MAD_TO_SD;
  return {median:med,scale:Math.max(mad,INPUTS[input].floor(med)),n:values.length};
}
// Confidence never exceeds what the data supports: it scales with input
// coverage (sum of available weights) and baseline completeness, and each capped
// (anomalous) input lowers it.
export function confidenceFor(coverage,baselineDays,anomalyCount){
  const score=coverage*Math.min(1,baselineDays/BASELINE_DAYS)*Math.max(0,1-0.15*anomalyCount);
  return {score:round(score,2),level:score>=0.75?"high":score>=0.5?"moderate":"low"};
}
export function estimateDay(days,day){
  const row=days.get(day);
  let baselineDays=0;
  for(let i=1;i<=BASELINE_DAYS;i++)if(required(days.get(shift(day,-i))))baselineDays++;
  const base={date:day,baseline_days:baselineDays,label:STRESS_LABEL};
  if(!row||!required(row)){
    return {...base,value:null,band:null,status:"missing_required_inputs",coverage:0,confidence:{score:0,level:"none"},
      limitations:["HRV and resting heart rate are both required for an estimate on this day."],
      inputs_used:[],inputs_missing:Object.keys(INPUTS).filter(k=>!row||row[k]==null),contributions:{}};
  }
  if(baselineDays<MIN_BASELINE_DAYS){
    return {...base,value:null,band:null,status:"insufficient_baseline",coverage:0,confidence:{score:0,level:"none"},
      limitations:["Fewer than 14 scored days in the prior 30, so no estimate is shown."],
      inputs_used:[],inputs_missing:Object.keys(INPUTS).filter(k=>row[k]==null),contributions:{}};
  }
  const parts=[];
  for(const [key,spec] of Object.entries(INPUTS)){
    if(row[key]==null)continue;
    const b=baselineFor(days,day,key);
    if(!b||b.n<MIN_BASELINE_DAYS)continue;
    const z=Math.max(-Z_CLIP,Math.min(Z_CLIP,spec.direction*(row[key]-b.median)/b.scale));
    parts.push({key,z,weight:CLUSTERS[spec.cluster]*spec.weight});
  }
  const used=parts.map(p=>p.key);
  const total=parts.reduce((s,p)=>s+p.weight,0);
  const contributions={};
  let sum=0;
  for(const p of parts){
    const points=(50/Z_CLIP)*p.z*p.weight/total;
    contributions[p.key]=round(points);
    sum+=points;
  }
  const value=Math.round(Math.max(0,Math.min(100,50+sum)));
  const missing=Object.keys(INPUTS).filter(k=>!used.includes(k));
  const anomalies=parts.filter(p=>Math.abs(p.z)>=Z_CLIP).map(p=>p.key);
  const confidence=confidenceFor(total,baselineDays,anomalies.length);
  const notes=[];
  if(missing.length)notes.push("Not every input was available, so the estimate uses fewer measurements.");
  if(baselineDays<BASELINE_DAYS)notes.push("The 30-day history is partial.");
  if(anomalies.length)notes.push("At least one input was far outside the usual range and was capped.");
  return {...base,label:STRESS_LABEL,value,band:bandFor(value),status:"ok",coverage:round(total,2),
    confidence,anomalies,inputs_used:used,inputs_missing:missing,contributions,
    measurements:Object.fromEntries(used.map(k=>[k,round(row[k],2)])),limitations:notes};
}
// targetDates: the dates returned to the user. History rows only form baselines.
export function computeStressEstimate({recoveryRecords=[],sleepRecords=[],targetDates=null,sleepAvailable=false}={}){
  const {days,excluded}=dailyInputs(recoveryRecords,sleepRecords);
  const dates=(targetDates?[...new Set(targetDates)]:[...days.keys()]).filter(Boolean).sort();
  const points=dates.map(day=>estimateDay(days,day));
  const valued=points.filter(p=>p.value!=null);
  return {
    metric:"stress_estimate",name:STRESS_NAME,label:STRESS_LABEL,experimental:true,version:STRESS_VERSION,unit:"index",
    scale:{min:0,max:100,personal_typical:50},
    available:valued.length>0,
    reason:valued.length?null:(points.some(p=>p.status==="insufficient_baseline")?"insufficient_baseline":"insufficient_data"),
    date_range:dates.length?{start:dates[0],end:dates.at(-1)}:null,
    method:{baseline_days:BASELINE_DAYS,min_baseline_days:MIN_BASELINE_DAYS,center:"median",spread:"MAD x 1.4826",
      z_clip:Z_CLIP,clusters:CLUSTERS,inputs:Object.fromEntries(Object.entries(INPUTS).map(([k,v])=>[k,{label:v.label,unit:v.unit,
        direction:v.direction>0?"higher_is_more_load":"lower_is_more_load",cluster:v.cluster,weight_in_cluster:v.weight}])),
      excluded:EXCLUDED,bands:BANDS,sleep_join:"recovery.sleep_id = sleep.id",sleep_data:sleepAvailable?"included":"not_available"},
    excluded_days:excluded,
    points,
    latest:valued.length?{date:valued.at(-1).date,value:valued.at(-1).value,band:valued.at(-1).band,
      confidence:valued.at(-1).confidence.level,baseline_days:valued.at(-1).baseline_days}:null,
    limitations:LIMITATIONS
  };
}
