import {effectiveLifeSchedule,readLifeSchedule} from './life-schedule.mjs';

const DAY=86400000;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const round=value=>Math.round(value*100)/100;
const dateOf=record=>{
  for(const value of [record.end,record.date,record.created_at,record.start]){
    const time=typeof value==='string'?Date.parse(value):NaN;
    if(Number.isFinite(time))return time;
  }
  return null;
};
function observed(record){
  const score=record.score??{},stage=score.stage_summary??{},need=score.sleep_needed??{};
  const values={};
  const put=(key,value,factor=1)=>{if(number(value)!=null)values[key]=value/factor;};
  put('hrv_ms',score.hrv_rmssd_milli);
  put('resting_heart_rate_bpm',score.resting_heart_rate);
  put('recovery_percent',score.recovery_score);
  put('sleep_efficiency_percent',score.sleep_efficiency_percentage);
  put('sleep_consistency_percent',score.sleep_consistency_percentage);
  put('sleep_debt_minutes',need.need_from_sleep_debt_milli,60000);
  if(record.sport_id==null)put('daily_strain',score.strain);
  if(record.sport_id!=null)put('activity_kilojoules',score.kilojoule);
  const parts=[stage.total_light_sleep_time_milli,stage.total_slow_wave_sleep_time_milli,stage.total_rem_sleep_time_milli];
  if(parts.every(x=>number(x)!=null)){
    values.sleep_duration_minutes=parts.reduce((a,b)=>a+b,0)/60000;
    if([need.baseline_milli,need.need_from_sleep_debt_milli,need.need_from_recent_strain_milli,need.need_from_recent_nap_milli].every(x=>number(x)!=null)){
      const required=(need.baseline_milli+need.need_from_sleep_debt_milli+need.need_from_recent_strain_milli-need.need_from_recent_nap_milli)/60000;
      values.sleep_deficit_minutes=Math.max(0,required-values.sleep_duration_minutes);
    }
    // Local wall time only when WHOOP supplies the offset. Never infer a timezone.
    const offset=typeof record.timezone_offset==='string'?/^([+-])(\d{2}):(\d{2})$/.exec(record.timezone_offset):null;
    const start=Date.parse(record.start);
    if(offset&&+offset[2]<=14&&+offset[3]<60&&Number.isFinite(start)){
      const shift=(+offset[2]*60 + +offset[3])*(offset[1]==='-'?-1:1);
      const local=new Date(start+shift*60000);
      values.sleep_start_local_minutes=local.getUTCHours()*60+local.getUTCMinutes();
    }
  }
  return values;
}
function circularVariation(values){
  if(values.length<2)return null;
  const angles=values.map(v=>v*2*Math.PI/1440);
  const x=angles.reduce((s,a)=>s+Math.cos(a),0)/angles.length;
  const y=angles.reduce((s,a)=>s+Math.sin(a),0)/angles.length;
  const r=Math.min(1,Math.max(0,Math.hypot(x,y)));
  return round(r===0?720:Math.min(720,Math.sqrt(-2*Math.log(r))*1440/(2*Math.PI)));
}
export function buildLifeScheduleInsights({schedule,records=[],now=Date.now(),complete=false}={}){
  const preference=effectiveLifeSchedule(schedule);
  const today=new Date(now).toISOString().slice(0,10);
  const byMetric=new Map(),seen=new Set();
  for(const record of records.slice(0,2000)){
    if(!record||typeof record!=='object'||record.nap===true)continue;
    const time=dateOf(record);
    if(time==null||time>now||time<now-31*DAY)continue;
    // Resource prefixes avoid collisions between WHOOP's independent id spaces.
    const type=record.score?.recovery_score!=null?'recovery':record.score?.stage_summary?'sleep':record.sport_id!=null?'workout':'cycle';
    const key=type+':'+String(record.id??record.cycle_id??record.start??time);
    if(seen.has(key))continue;
    seen.add(key);
    const day=new Date(time).toISOString().slice(0,10);
    for(const [metric,value] of Object.entries(observed(record))){
      if(!byMetric.has(metric))byMetric.set(metric,new Map());
      const days=byMetric.get(metric),prior=days.get(day);
      if(metric==='activity_kilojoules')days.set(day,{date:day,time,value:(prior?.value??0)+value});
      else if(!prior||prior.time<time)days.set(day,{date:day,time,value});
    }
  }
  const windows=[7,14,30].map(days=>{
    const start=new Date(Date.parse(today+'T00:00:00Z')-(days-1)*DAY).toISOString().slice(0,10);
    const metrics={};
    for(const [metric,dated] of byMetric){
      const points=[...dated.values()].filter(p=>p.date>=start).sort((a,b)=>a.time-b.time);
      if(!points.length)continue;
      const values=points.map(p=>p.value);
      const average=values.reduce((a,b)=>a+b,0)/values.length;
      const deviation=values.length>1?round(Math.sqrt(values.reduce((sum,v)=>sum+(v-average)**2,0)/values.length)):null;
      const common={observed_days:points.length,missing_days:days-points.length,latest_date:points.at(-1).date};
      metrics[metric]=metric==='sleep_start_local_minutes'
        ?{...common,circular_variability_minutes:circularVariation(values)}
        :{...common,unit:metric.split('_').at(-1),mean:round(average),standard_deviation:deviation,min:round(Math.min(...values)),max:round(Math.max(...values)),latest:round(values.at(-1)),change:values.length>1?round(values.at(-1)-values[0]):null};
    }
    return {days,start,end:today,metrics};
  });
  const interpretation={fixed:'Use the explicitly chosen routine as context, without requiring stricter timing.',flexible:'Allow routine adjustments; protect sleep opportunity around changing demands.',unpredictable:'Accommodate variable timing; focus on feasible sleep opportunity and physiological patterns.'}[preference];
  const recommendations=[];
  const recent=windows[0].metrics;
  if(recent.sleep_deficit_minutes?.latest>0)recommendations.push('Recorded sleep was below WHOOP-estimated need. '+({fixed:'Allow sufficient sleep opportunity within the chosen routine.',flexible:'Find feasible additional sleep opportunity around changing commitments.',unpredictable:'Use feasible opportunities for sufficient sleep without requiring fixed bedtimes.'}[preference]));
  if(recent.sleep_debt_minutes?.latest>0)recommendations.push('Recorded sleep debt remains present; variability does not erase that deficit. Sleep debt is a measured WHOOP state, not a sum of repeated daily balances.');
  if(recent.recovery_percent?.change<0||recent.hrv_ms?.change<0||recent.resting_heart_rate_bpm?.change>0)
    recommendations.push('Recovery-related measurements changed over the observed window. Compare sleep sufficiency and activity alongside those changes; timing alone does not establish their cause.');
  return {life_schedule:preference,interpretation,windows,recommendations,
    limitations:[complete?'History retrieval completed; missing observations still limit interpretation.':'History is incomplete; window statistics describe only available observations.',
      'Windows use UTC calendar dates, including the current partial day. Local sleep timing requires an explicit timezone offset; naps are excluded.',
      'Observed associations do not establish causation. Irregular timing or low consistency alone does not justify adopting a fixed schedule. No preference is inferred or changed.']};
}
export async function contextualLifeSchedule(ctx,records,complete=false){
  const preference=await readLifeSchedule(ctx.db,ctx.userId,{env:ctx.env});
  return buildLifeScheduleInsights({schedule:preference.life_schedule,records,complete,now:ctx.now??Date.now()});
}
