import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {computeStressEstimate,dailyInputs,confidenceFor,STRESS_LABEL,MIN_BASELINE_DAYS} from "../src/stress-estimate.mjs";
import {attachSummary} from "../src/ai-summary.mjs";
import {syntheticUser,day} from "./stress-fixture-data.mjs";

const rec=(i,{hrv,rhr,recovery=60,sleepId=null,cycle=null,state="SCORED",calibrating=false}={})=>({
  cycle_id:cycle??(100+i),sleep_id:sleepId,created_at:day(i)+"T07:00:00Z",score_state:state,
  score:{user_calibrating:calibrating,recovery_score:recovery,hrv_rmssd_milli:hrv,resting_heart_rate:rhr}});
// 20 baseline days alternating HRV 50/60 (median 55, MAD 5) and RHR 50/54 (median 52, MAD 2).
function baseline(n=20,start=0){
  return Array.from({length:n},(_,k)=>rec(start+k,{hrv:k%2?60:50,rhr:k%2?54:50}));
}
const point=(est,date)=>est.points.find(p=>p.date===date);

test("hand-computed value: z = +1 on HRV and RHR gives 50 + 16.67 = 67",()=>{
  const t=20;
  const records=[...baseline(),rec(t,{hrv:55-5*1.4826,rhr:52+2*1.4826})];
  const est=computeStressEstimate({recoveryRecords:records,targetDates:[day(t)]});
  const p=point(est,day(t));
  assert.equal(p.status,"ok");
  assert.equal(p.contributions.hrv_rmssd,10);
  assert.equal(p.contributions.resting_heart_rate,6.67);
  assert.equal(p.value,67);
  assert.equal(p.band,"elevated");
  assert.equal(p.coverage,0.6);
  // 0.6 coverage x 20/30 baseline days = 0.4: low, never overstated.
  assert.deepEqual(p.confidence,{score:0.4,level:"low"});
  assert.deepEqual(p.inputs_used,["hrv_rmssd","resting_heart_rate"]);
  assert.ok(p.inputs_missing.includes("sleep_performance"));
  assert.equal(p.label,STRESS_LABEL);
  assert.match(est.name,/experimental physiological stress estimate/);
  assert.equal(est.experimental,true);
});

test("recovery_score is excluded: changing it never changes the value",()=>{
  const a=computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:50,rhr:54,recovery:5})],targetDates:[day(20)]});
  const b=computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:50,rhr:54,recovery:99})],targetDates:[day(20)]});
  assert.equal(point(a,day(20)).value,point(b,day(20)).value);
  assert.ok(!("recovery_score" in point(a,day(20)).contributions));
  assert.ok(a.method.excluded.recovery_score);
});

test("baseline boundary: exactly 14 prior days estimates, 13 is insufficient",()=>{
  const ok=computeStressEstimate({recoveryRecords:[...baseline(MIN_BASELINE_DAYS),rec(14,{hrv:55,rhr:52})],targetDates:[day(14)]});
  assert.equal(point(ok,day(14)).status,"ok");
  assert.equal(point(ok,day(14)).baseline_days,14);
  const short=computeStressEstimate({recoveryRecords:[...baseline(13),rec(13,{hrv:55,rhr:52})],targetDates:[day(13)]});
  const p=point(short,day(13));
  assert.equal(p.status,"insufficient_baseline");
  assert.equal(p.value,null);assert.equal(p.band,null);
  assert.equal(p.confidence.level,"none");
  assert.equal(short.available,false);assert.equal(short.reason,"insufficient_baseline");
  // Days older than 30 do not count toward the baseline.
  const old=computeStressEstimate({recoveryRecords:[...baseline(20),rec(55,{hrv:55,rhr:52})],targetDates:[day(55)]});
  assert.equal(point(old,day(55)).status,"insufficient_baseline");
});

test("zero variance uses the scale floor and stays finite",()=>{
  const flat=Array.from({length:20},(_,k)=>rec(k,{hrv:50,rhr:50}));
  const same=computeStressEstimate({recoveryRecords:[...flat,rec(20,{hrv:50,rhr:50})],targetDates:[day(20)]});
  assert.equal(point(same,day(20)).value,50);
  const moved=point(computeStressEstimate({recoveryRecords:[...flat,rec(20,{hrv:49,rhr:51})],targetDates:[day(20)]}),day(20));
  // HRV floor max(1, 5% of 50) = 2.5 -> z 0.4; RHR floor 1 -> z 1.
  assert.equal(moved.contributions.hrv_rmssd,4);
  assert.equal(moved.contributions.resting_heart_rate,6.67);
  assert.ok(Number.isFinite(moved.value));
});

test("outliers are clipped at |z| = 3, flagged, and lower confidence",()=>{
  const p=point(computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:5,rhr:52})],targetDates:[day(20)]}),day(20));
  assert.equal(p.contributions.hrv_rmssd,30);
  assert.deepEqual(p.anomalies,["hrv_rmssd"]);
  assert.ok(p.limitations.some(l=>/capped/.test(l)));
  assert.ok(p.confidence.score<confidenceFor(0.6,20,0).score);
});

test("missing required inputs, unscored and calibrating days are not estimated",()=>{
  const records=[...baseline(),rec(20,{hrv:55,rhr:null}),rec(21,{hrv:55,rhr:52,state:"PENDING_SCORE"}),rec(22,{hrv:55,rhr:52,calibrating:true})];
  const est=computeStressEstimate({recoveryRecords:records,targetDates:[day(20),day(21),day(22)]});
  for(const d of [20,21,22]){
    const p=point(est,day(d));
    assert.equal(p.value,null);assert.equal(p.status,"missing_required_inputs");
  }
  assert.equal(est.excluded_days,2);
  assert.equal(est.available,false);
});

test("sleep joins only by recovery.sleep_id, never by calendar day",()=>{
  const sleep=(id,d,perf)=>({id,start:day(d-1)+"T23:00:00Z",end:day(d)+"T06:00:00Z",score_state:"SCORED",
    score:{sleep_performance_percentage:perf,sleep_efficiency_percentage:90,respiratory_rate:15,
      stage_summary:{total_light_sleep_time_milli:3*3600000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:3600000}}});
  const recs=Array.from({length:21},(_,k)=>rec(k,{hrv:k%2?60:50,rhr:k%2?54:50,sleepId:"s"+k}));
  const sleeps=Array.from({length:21},(_,k)=>sleep("s"+k,k,85));
  const joined=dailyInputs(recs,sleeps).days.get(day(20));
  assert.equal(joined.sleep_performance,85);
  assert.equal(joined.sleep_duration,5);
  // Same calendar night, different id: not joined.
  const other=dailyInputs([rec(20,{hrv:55,rhr:52,sleepId:"nope"})],[sleep("s20",20,40)]).days.get(day(20));
  assert.equal(other.sleep_performance,null);
  const noId=dailyInputs([rec(20,{hrv:55,rhr:52})],[sleep("s20",20,40)]).days.get(day(20));
  assert.equal(noId.sleep_performance,null);
});

test("duplicate cycles on one day keep the highest cycle id regardless of order",()=>{
  const a=rec(20,{hrv:40,rhr:52,cycle:500}),b=rec(20,{hrv:70,rhr:52,cycle:501});
  assert.equal(dailyInputs([a,b]).days.get(day(20)).hrv_rmssd,70);
  assert.equal(dailyInputs([b,a]).days.get(day(20)).hrv_rmssd,70);
});

test("sample fixture matches the calculation (regenerate with node test/make-stress-fixture.mjs)",()=>{
  const fixture=JSON.parse(readFileSync(new URL("./fixtures/stress-estimate-sample.json",import.meta.url),"utf8"));
  const u=syntheticUser();
  const targetDates=u.recoveries.slice(-10).map(r=>r.created_at.slice(0,10));
  const out=computeStressEstimate({recoveryRecords:u.recoveries,sleepRecords:u.sleeps,targetDates,sleepAvailable:true});
  assert.deepEqual(JSON.parse(JSON.stringify(out)),fixture);
  assert.ok(fixture.points.slice(0,5).every(p=>p.band==="typical"));
  assert.ok(fixture.points.slice(5).every(p=>p.value>80));
});

// attachSummary integration: per-user history, flag behavior, logs.
function whoopFor(users,calls){
  return async(db,userId,resource,env,opts)=>{
    calls.push({userId,resource});
    const u=users[userId];
    if(!u)throw Error("no such user");
    // Newest first, 25 per page, like the WHOOP API.
    const all=(resource==="sleep"?u.sleeps:u.recoveries).slice().reverse();
    const offset=opts?.next_token?Number(opts.next_token):0;
    const next=offset+25<all.length?String(offset+25):null;
    return {records:all.slice(offset,offset+25),next_token:next};
  };
}
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function run(userId,users,env,calls,logs){
  const page={records:users[userId].recoveries.slice(-3),next_token:null};
  const orig=console.log;console.log=(...a)=>logs.push(a.join(" "));
  try{
    return await attachSummary(page,{db:null,userId,tool:"get_recovery",env,whoopRequest:whoopFor(users,calls),now:Date.parse("2026-10-20T00:00:00Z")});
  }finally{console.log=orig;}
}

test("each user's estimate uses only that user's history, and logs hold no health values",async()=>{
  const users={[A]:syntheticUser({prefix:"a"}),[B]:syntheticUser({days:10,seed:7,prefix:"b"})};
  const calls=[],logs=[];
  const env={STRESS_ESTIMATE_ENABLED:"true"};
  const a=await run(A,users,env,calls,logs);
  const b=await run(B,users,env,calls,logs);
  assert.ok(calls.every(c=>c.userId===A||c.userId===B));
  assert.ok(calls.filter(c=>c.userId===A).length>0&&calls.filter(c=>c.userId===B).length>0);
  const sa=a.summary.chart_data.stress_estimate,sb=b.summary.chart_data.stress_estimate;
  assert.equal(sa.available,true);
  // B has only 10 days of its own history, so A's 45 days must not fill B's baseline.
  assert.equal(sb.available,false);
  assert.ok(sb.points.every(p=>p.baseline_days<MIN_BASELINE_DAYS));
  const text=logs.join("\n");
  for(const r of [...users[A].recoveries,...users[B].recoveries]){
    assert.ok(!text.includes(String(r.score.hrv_rmssd_milli)),"log leaked a value");
  }
  for(const p of sa.points)if(p.value!=null)assert.ok(!text.includes('"value":'+p.value));
});

test("flag off: no estimate, no sleep fetch, output unchanged",async()=>{
  const users={[A]:syntheticUser({prefix:"a"})};
  for(const flag of [undefined,"false","TRUE"]){
    const calls=[],logs=[];
    const env=flag===undefined?{}:{STRESS_ESTIMATE_ENABLED:flag};
    const out=await run(A,users,env,calls,logs);
    assert.equal(out.summary.chart_data.stress_estimate,null);
    assert.equal(Object.hasOwn(out.summary.stats,"stress_estimate"),false);
    assert.ok(!calls.some(c=>c.resource==="sleep"));
  }
});

test("flag on with a non-recovery tool reports requires_recovery_data",async()=>{
  const out=await attachSummary({records:[{created_at:"2026-10-01T07:00:00Z",score_state:"SCORED",score:{strain:10}}],next_token:null},
    {db:null,userId:A,tool:"get_cycles",env:{STRESS_ESTIMATE_ENABLED:"true"}});
  const s=out.summary.chart_data.stress_estimate;
  assert.equal(s.available,false);assert.equal(s.reason,"requires_recovery_data");assert.equal(s.experimental,true);
});

test("summary vocabulary accepts a factual stress sentence and still rejects advice",async()=>{
  const {outputRejection}=await import("../src/ai-summary.mjs");
  const stats={count:3,sources:[{source:"WHOOP",count:3}],metrics:{"score.recovery_score":{min:35,max:44,mean:40,median:40}},
    stress_estimate:{name:"WHOOP Lens experimental physiological stress estimate",experimental:true,date:"2026-10-15",value:72,band:"elevated",confidence:"moderate",baseline_days:30}};
  assert.equal(outputRejection("The WHOOP Lens experimental physiological stress estimate was 72 on 2026-10-15, in the elevated band with moderate confidence.",stats),null);
  assert.equal(outputRejection("The stress estimate was 72, so you should rest.",stats).rule,"advice");
  assert.equal(outputRejection("The stress estimate was 90 on 2026-10-15.",stats).rule,"number");
  assert.notEqual(outputRejection("The stress estimate was 72, indicating burnout.",stats),null);
  assert.equal(outputRejection("The stress estimate was 72 amid zebras.",stats).rule,"vocabulary");
});
