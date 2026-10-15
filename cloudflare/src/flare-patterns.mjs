// Descriptive analysis only. No trained predictor, external model, or persisted inference.
import {parseWeekEnding} from './ai-digest.mjs';
const DAY=86400000;
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
function dateOf(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!parseWeekEnding(value.slice(0,10)))return null;
 const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString().slice(0,10):null;
}
const metricDefs={
 recovery:[['recovery_score','score',0,100],['hrv_rmssd_milli','ms',0,1000],['resting_heart_rate','bpm',20,250]],
 sleep:[['sleep_performance_percentage','percent',0,100],['respiratory_rate','breaths/min',5,60]],
 cycles:[['strain','index',0,21]]
};
const round=x=>Math.round(x*10000)/10000;
function stats(points){
 const values=points.map(p=>p.value),n=values.length;
 if(!n)return {days:0,mean:null,min:null,max:null,sample_sd:null,dates:[]};
 const mean=values.reduce((a,b)=>a+b,0)/n;
 return {days:n,mean:round(mean),min:Math.min(...values),max:Math.max(...values),sample_sd:n>1?round(Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/(n-1))):null,dates:points.map(p=>p.date)};
}
async function history(ctx,resource,start,end){
 const rows=[],seen=new Set();let token=null,complete=false;
 try{
  for(let i=0;i<6;i++){
   const page=await ctx.whoopRequest(ctx.db,ctx.userId,resource,ctx.env,{limit:25,next_token:token,start:start+'T00:00:00Z',end:shift(end,1)+'T00:00:00Z'});
   if(!page||!Array.isArray(page.records)||page.records.length>25||page.records.some(r=>!r||typeof r!=='object'||Array.isArray(r)))break;
   rows.push(...page.records);
   const next=page.next_token??null;
   if(next===null){complete=true;break;}
   if(typeof next!=='string'||!next.length||next.length>512||! /^[A-Za-z0-9._~+/-]+$/.test(next)||next.includes('..')||seen.has(next))break;
   seen.add(next);token=next;
  }
 }catch{/* Retain partial observations; never pretend the source had no records. */}
 return {rows,complete};
}
export async function analyzeFlarePatterns(entries,{start,end},ctx){
 const labels=new Map(entries.map(e=>[e.date,e]));
 const days=[];for(let d=start;d<=end;d=shift(d,1))days.push(d);
 const coverage={},metrics=[];
 for(const resource of Object.keys(metricDefs)){
  const result=await history(ctx,resource,shift(start,resource==='sleep'?-4:-3),end);
  const unique=new Map();let duplicateRecords=0;
  for(const r of result.rows){
   const key=r.id??r.cycle_id??JSON.stringify(r);
   const old=unique.get(key);
   if(old){duplicateRecords++;if((Date.parse(r.updated_at)||0)<=(Date.parse(old.updated_at)||0))continue;}
   unique.set(key,r);
  }
  const byMetric=new Map(metricDefs[resource].map(([name])=>[name,new Map()]));
  let excluded=0;
  for(const r of unique.values()){
   // Date basis is explicit, never inferred from a different user's or metric's record.
   const date=dateOf(resource==='recovery'?r.created_at:resource==='sleep'?r.end:r.start);
   if(!date||date<shift(start,-3)||date>end||r.score_state!=='SCORED'||!r.score||(resource==='sleep'&&r.nap===true)||(resource==='cycles'&&!dateOf(r.end))){excluded++;continue;}
   let included=false;
   for(const [name,,min,max] of metricDefs[resource]){
    const value=r.score[name];if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)continue;
    const map=byMetric.get(name);if(!map.has(date))map.set(date,[]);map.get(date).push(value);included=true;
   }
   if(!included)excluded++;
  }
  coverage[resource]={retrieval_complete:result.complete,returned_records:result.rows.length,duplicate_records:duplicateRecords,excluded_records:excluded,date_basis:resource==='recovery'?'created_at UTC':resource==='sleep'?'end UTC (naps excluded)':'start UTC (closed cycles only)'};
  for(const [name,unit] of metricDefs[resource]){
   const daily=byMetric.get(name);
   const points=[...daily].sort(([a],[b])=>a.localeCompare(b)).map(([date,values])=>({date,value:round(values.reduce((a,b)=>a+b,0)/values.length),records:values.length}));
   const byDay=new Map(points.map(p=>[p.date,p]));
   const comparisons=[];
   for(const lag of [0,1,2,3]){
    const flare=[],nonflare=[];
    for(const day of days){
     const e=labels.get(day),point=byDay.get(shift(day,-lag));
     if(!point||!['yes','no'].includes(e?.flare))continue;
     (e.flare==='yes'?flare:nonflare).push({...point,date:day,measurement_date:point.date});
    }
    const a=stats(flare),b=stats(nonflare);
    comparisons.push({lag_days:lag,meaning:lag?`Measurement ${lag} UTC day(s) before the user label`:'Same UTC day; not a leading signal',flare:a,nonflare:b,mean_difference:a.days&&b.days?round(a.mean-b.mean):null,comparison_available:!!(a.days&&b.days),confidence:'Descriptive only; predictive performance not evaluated',paired_dates:[...flare,...nonflare].map(p=>({label_date:p.date,measurement_date:p.measurement_date,label:labels.get(p.date).flare}))});
   }
   metrics.push({metric:name,source:'WHOOP '+resource,unit,daily_reduction:'Arithmetic mean of scored records assigned to that UTC day',points,personal_reference:stats(points.filter(p=>p.date>=start)),missing_dates:days.filter(d=>!byDay.has(d)),comparisons});
  }
 }
 const complete=Object.values(coverage).every(c=>c.retrieval_complete);
 return {kind:'personal_flare_patterns',period:{start,end,timezone:'UTC'},analysis_version:'descriptive-v1',source:'Explicit user labels compared with this account\'s WHOOP measurements',
  evidence:{labeled_flare_days:entries.filter(e=>e.flare==='yes').length,labeled_nonflare_days:entries.filter(e=>e.flare==='no').length,unknown_or_unlogged_dates:days.filter(d=>!['yes','no'].includes(labels.get(d)?.flare)),reported_confounder_days:entries.filter(e=>e.confounders?.length).map(e=>e.date),retrieval_complete:complete},
  coverage,metrics,warning:{status:'insufficient_evidence',message:'insufficient evidence for a flare warning',prediction_enabled:false},
  limitations:['Observed within-person differences are not causal or diagnostic.','Explicit non-flare labels are required; missing labels are never controls.','Adjacent days and overlapping lag windows are not independent flare events.','Multiple comparisons are exploratory; no significance or predictive accuracy is established.','Reported confounders are flagged, not statistically adjusted. Unreported confounders may remain.','The personal reference includes flare and non-flare days; it is not a healthy baseline.','UTC alignment can differ from local symptom timing.','No medication advice, external AI processing, training, notifications or cached medical inferences.',...(complete?[]:['History retrieval was incomplete; missing observations do not prove no measurement occurred.'])]};
}
