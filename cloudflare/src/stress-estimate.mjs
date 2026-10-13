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
// Physiologically plausible ranges. A value outside is treated as a sensor or
// data artifact: it is not scored, not used in any baseline, and reported.
export const PLAUSIBLE=Object.freeze({
  hrv_rmssd:[5,300],resting_heart_rate:[25,130],sleep_performance:[0,100],
  sleep_duration:[0.5,16],sleep_efficiency:[0,100],respiratory_rate:[5,40]
});
// An unsupported deviation this large (|raw z| >= 8, before clipping) is treated
// as a suspected artifact rather than a real change, and is not scored.
export const ARTIFACT_Z=8;
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
  "Days without enough history (at least 14 scored days in the prior 30) are reported as insufficient instead of estimated.",
  "Confidence describes how good the evidence is (input coverage, each input's own baseline completeness, conflicts and artifacts), not how large the change is. Inputs agreeing in direction are not penalized, but agreement is not treated as proof."
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
function plausible(key,v){
  if(!isNum(v))return null;
  const [lo,hi]=PLAUSIBLE[key];
  return v>=lo&&v<=hi;
}
// Returns [value or null, artifact note or null].
function checked(key,v){
  if(v==null)return [null,null];
  return plausible(key,v)?[v,null]:[null,key];
}
// The recovery's own day, the same rule used to build rows. Used by callers to
// derive target dates only from recovery records.
export function isRecoveryRecord(r){
  return !!r&&typeof r==="object"&&!Array.isArray(r)&&Object.hasOwn(r,"cycle_id")&&!Object.hasOwn(r,"start")&&!Object.hasOwn(r,"nap");
}
export function recoveryDay(r){
  return isRecoveryRecord(r)?(isoDay(r.created_at)||isoDay(r.updated_at)):null;
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
    const [hrv,a1]=checked("hrv_rmssd",isNum(s.hrv_rmssd_milli)?s.hrv_rmssd_milli:null);
    const [rhr,a2]=checked("resting_heart_rate",isNum(s.resting_heart_rate)?s.resting_heart_rate:null);
    const row={day,cycle:idOf(r.cycle_id),sleep_id:idOf(r.sleep_id),
      artifacts:[a1,a2].filter(Boolean),hrv_rmssd:hrv,resting_heart_rate:rhr,
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
    const [perf,b1]=checked("sleep_performance",isNum(s.sleep_performance_percentage)?s.sleep_performance_percentage:null);
    const [eff,b2]=checked("sleep_efficiency",isNum(s.sleep_efficiency_percentage)?s.sleep_efficiency_percentage:null);
    const [dur,b3]=checked("sleep_duration",asleep.every(isNum)?asleep.reduce((a,b)=>a+b,0)/3600000:null);
    const [resp,b4]=checked("respiratory_rate",isNum(s.respiratory_rate)?s.respiratory_rate:null);
    byId.set(id,{sleep_performance:perf,sleep_efficiency:eff,sleep_duration:dur,respiratory_rate:resp,
      artifacts:[b1,b2,b3,b4].filter(Boolean)});
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
      recovery_score:r.recovery_score,skin_temp:r.skin_temp,artifacts:[...r.artifacts,...(sleep.artifacts||[])]});
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
// Confidence is evidence quality only, never the size of the change:
//   evidence = sum over scored inputs of effective weight x min(1, that input's
//              own baseline values / 30)   (1.0 = all six inputs, full baselines)
//   score    = evidence x max(0, 1 - 0.15 x conflicts)
// Conflicts: capped inputs that disagree with the others, lone capped outliers,
// suspected artifacts and implausible values. Capped inputs that agree with the
// others are not conflicts, and agreement never raises confidence above evidence.
export function confidenceFor(evidence,conflictCount=0){
  const score=evidence*Math.max(0,1-0.15*conflictCount);
  return {score:round(score,2),level:score>=0.75?"high":score>=0.5?"moderate":"low"};
}
const AGREE_Z=1;
function othersMean(parts,p){
  const others=parts.filter(o=>o!==p);
  const w=others.reduce((s,o)=>s+o.weight,0);
  return {n:others.length,mean:w>0?others.reduce((s,o)=>s+o.z*o.weight,0)/w:0};
}
// Classifies every input whose raw |z| reached the clip. relation:
//   agrees             others' weighted mean z >= 1 in the same direction (kept, no penalty)
//   disagrees          others point the other way (kept, penalty)
//   lone_outlier       others did not move with it (kept, penalty)
//   suspected_artifact unsupported and |raw z| >= 8 (not scored, penalty)
export function classifyClipped(parts){
  const out=[];
  for(const p of parts){
    if(Math.abs(p.raw)<Z_CLIP)continue;
    const {n,mean}=othersMean(parts,p);
    let kind;
    if(n&&Math.abs(mean)>=AGREE_Z)kind=Math.sign(mean)===Math.sign(p.raw)?"agrees":"disagrees";
    else if(n&&Math.abs(mean)>=0.5&&Math.sign(mean)===-Math.sign(p.raw))kind="disagrees";
    else kind=Math.abs(p.raw)>=ARTIFACT_Z?"suspected_artifact":"lone_outlier";
    const label=INPUTS[p.key].label;
    out.push({input:p.key,capped_z:round(Math.max(-Z_CLIP,Math.min(Z_CLIP,p.raw)),2),
      direction:p.raw>0?"toward_more_load":"toward_less_load",relation:kind,
      lowers_confidence:kind!=="agrees",scored:kind!=="suspected_artifact",
      note:kind==="agrees"?`${label} was far outside the usual range and capped; the other inputs moved the same way, so confidence is not reduced.`:
        kind==="disagrees"?`${label} was far outside the usual range and capped, and it moved opposite to the other inputs, so confidence is reduced.`:
        kind==="lone_outlier"?`${label} was far outside the usual range and capped, and the other inputs did not move with it (possible measurement anomaly), so confidence is reduced.`:
        `${label} was extremely far from the usual range with no support from the other inputs, so it is treated as a suspected artifact, not scored, and confidence is reduced.`});
  }
  return out;
}
function implausibleNotes(row){
  return (row?.artifacts||[]).map(key=>({input:key,relation:"implausible_value",lowers_confidence:true,scored:false,
    note:`${INPUTS[key].label} was outside the plausible range (${PLAUSIBLE[key][0]}-${PLAUSIBLE[key][1]} ${INPUTS[key].unit}), so it was treated as a data artifact and not used.`}));
}
function requiredBaselineDays(days,day){
  let n=0;
  for(let i=1;i<=BASELINE_DAYS;i++)if(required(days.get(shift(day,-i))))n++;
  return n;
}
export function estimateDay(days,day,{historyComplete=true}={}){
  const row=days.get(day);
  const baselineDays=requiredBaselineDays(days,day);
  const base={date:day,baseline_days:baselineDays,label:STRESS_LABEL};
  const none={value:null,band:null,coverage:0,confidence:{score:0,level:"none"},deviation:null,contributions:{}};
  const artifactNotes=implausibleNotes(row);
  if(!row||!required(row)){
    return {...base,...none,status:"missing_required_inputs",anomalies:artifactNotes,
      limitations:["HRV and resting heart rate are both required for an estimate on this day.",...artifactNotes.map(a=>a.note)],
      inputs_used:[],inputs_missing:Object.keys(INPUTS).filter(k=>!row||row[k]==null)};
  }
  if(baselineDays<MIN_BASELINE_DAYS){
    const status=historyComplete?"insufficient_baseline":"incomplete_history";
    return {...base,...none,status,anomalies:artifactNotes,
      limitations:[historyComplete?"Fewer than 14 scored days in the prior 30, so no estimate is shown.":
        "The prior 30 days of history could not be fully retrieved, so no estimate is shown.",...artifactNotes.map(a=>a.note)],
      inputs_used:[],inputs_missing:Object.keys(INPUTS).filter(k=>row[k]==null)};
  }
  const candidates=[];
  for(const [key,spec] of Object.entries(INPUTS)){
    if(row[key]==null)continue;
    const b=baselineFor(days,day,key);
    if(!b||b.n<MIN_BASELINE_DAYS)continue;
    const raw=spec.direction*(row[key]-b.median)/b.scale;
    candidates.push({key,raw,z:Math.max(-Z_CLIP,Math.min(Z_CLIP,raw)),weight:CLUSTERS[spec.cluster]*spec.weight,n:b.n});
  }
  const clipped=classifyClipped(candidates);
  const artifactKeys=new Set(clipped.filter(a=>!a.scored).map(a=>a.input));
  const anomalies=[...clipped,...artifactNotes];
  if(artifactKeys.has("hrv_rmssd")||artifactKeys.has("resting_heart_rate")){
    return {...base,...none,status:"suspected_artifact",anomalies,
      limitations:["A required input looked like a measurement artifact, so no estimate is shown for this day.",...anomalies.map(a=>a.note)],
      inputs_used:[],inputs_missing:Object.keys(INPUTS).filter(k=>row[k]==null||artifactKeys.has(k))};
  }
  const parts=candidates.filter(p=>!artifactKeys.has(p.key));
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
  const evidence=parts.reduce((s,p)=>s+p.weight*Math.min(1,p.n/BASELINE_DAYS),0);
  const conflicts=anomalies.filter(a=>a.lowers_confidence).length;
  const confidence={...confidenceFor(evidence,conflicts),components:{
    input_coverage:round(total,2),
    baseline_completeness:total?round(evidence/total,2):0,
    conflicts,
    per_input:Object.fromEntries(parts.map(p=>[p.key,{baseline_values:p.n,completeness:round(Math.min(1,p.n/BASELINE_DAYS),2)}]))
  }};
  const strongest=parts.reduce((m,p)=>Math.abs(p.z)>Math.abs(m?.z??0)?p:m,null);
  const notes=[];
  if(missing.length)notes.push("Not every input was available, so the estimate uses fewer measurements.");
  if(parts.some(p=>p.n<BASELINE_DAYS))notes.push("At least one input has a partial 30-day baseline, which lowers confidence.");
  for(const a of anomalies)notes.push(a.note);
  return {...base,value,band:bandFor(value),status:"ok",coverage:round(total,2),
    confidence,
    deviation:{points_from_typical:value-50,direction:value>50?"toward_more_load":value<50?"toward_less_load":"none",
      largest_input:strongest?{input:strongest.key,z:round(strongest.z,2)}:null},
    anomalies,inputs_used:used,inputs_missing:missing,contributions,
    measurements:Object.fromEntries(used.map(k=>[k,round(row[k],2)])),limitations:notes};
}
const summaryOf=p=>p?{date:p.date,status:p.status,value:p.value,band:p.band,
  confidence:p.confidence.level,baseline_days:p.baseline_days}:null;
// targetDates: the dates returned to the user. History rows only form baselines.
// historyComplete=false means the needed history could not be fully retrieved;
// it is reported, and days short of baseline say incomplete_history.
export function computeStressEstimate({recoveryRecords=[],sleepRecords=[],targetDates=null,sleepAvailable=false,historyComplete=true,historyNote=null}={}){
  const {days,excluded}=dailyInputs(recoveryRecords,sleepRecords);
  const dates=(targetDates?[...new Set(targetDates)]:[...days.keys()]).filter(Boolean).sort();
  const points=dates.map(day=>estimateDay(days,day,{historyComplete}));
  const valued=points.filter(p=>p.value!=null);
  const requestedLatest=points.at(-1)||null;
  const latestValid=valued.at(-1)||null;
  let reason=null;
  if(!valued.length){
    if(points.some(p=>p.status==="incomplete_history"))reason="incomplete_history";
    else if(points.some(p=>p.status==="insufficient_baseline"))reason="insufficient_baseline";
    else reason="insufficient_data";
  }
  const limitations=[...LIMITATIONS];
  if(!historyComplete)limitations.unshift(historyNote||"Not all of the needed WHOOP history could be retrieved, so some baselines may be incomplete.");
  if(latestValid&&requestedLatest&&latestValid.date!==requestedLatest.date)
    limitations.unshift(`The latest requested date (${requestedLatest.date}) has no estimate; the most recent estimate is from ${latestValid.date}.`);
  return {
    metric:"stress_estimate",name:STRESS_NAME,label:STRESS_LABEL,experimental:true,version:STRESS_VERSION,unit:"index",
    scale:{min:0,max:100,personal_typical:50},
    available:valued.length>0,
    reason,
    date_range:dates.length?{start:dates[0],end:dates.at(-1)}:null,
    history:{complete:historyComplete},
    method:{baseline_days:BASELINE_DAYS,min_baseline_days:MIN_BASELINE_DAYS,center:"median",spread:"MAD x 1.4826",
      z_clip:Z_CLIP,artifact_z:ARTIFACT_Z,plausible_ranges:PLAUSIBLE,
      confidence:"sum of scored effective weights x each input's baseline completeness (n/30), x (1 - 0.15 per conflict); conflicts are disagreeing or unsupported capped inputs, suspected artifacts and implausible values",
      clusters:CLUSTERS,inputs:Object.fromEntries(Object.entries(INPUTS).map(([k,v])=>[k,{label:v.label,unit:v.unit,
        direction:v.direction>0?"higher_is_more_load":"lower_is_more_load",cluster:v.cluster,weight_in_cluster:v.weight}])),
      excluded:EXCLUDED,bands:BANDS,sleep_join:"recovery.sleep_id = sleep.id",sleep_data:sleepAvailable?"included":"not_available"},
    excluded_days:excluded,
    points,
    requested_latest_date:requestedLatest?.date??null,
    latest_requested:summaryOf(requestedLatest),
    latest_valid:summaryOf(latestValid),
    latest_valid_is_requested_latest:!!(latestValid&&requestedLatest&&latestValid.date===requestedLatest.date),
    limitations
  };
}
