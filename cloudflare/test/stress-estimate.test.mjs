import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {computeStressEstimate,dailyInputs,confidenceFor,STRESS_LABEL,MIN_BASELINE_DAYS,PLAUSIBLE} from "../src/stress-estimate.mjs";
import {attachSummary,systemPromptFor,outputRejection,stressTargetDates,fetchStressWindow,STRESS_RATE_LIMIT_NOTE,STRESS_HISTORY_NOTE} from "../src/ai-summary.mjs";
import {handleMcpRpc} from "../src/mcp.mjs";
import {buildWeeklyDigest,digestCacheScope} from "../src/ai-digest.mjs";
import {d1Database} from "./d1-sqlite.mjs";
import {syntheticUser,day} from "./stress-fixture-data.mjs";

const rec=(i,{hrv,rhr,recovery=60,sleepId=null,cycle=null,state="SCORED",calibrating=false}={})=>({
  cycle_id:cycle??(100+i),sleep_id:sleepId,created_at:day(i)+"T07:00:00Z",score_state:state,
  score:{user_calibrating:calibrating,recovery_score:recovery,hrv_rmssd_milli:hrv,resting_heart_rate:rhr}});
const sleepRec=(id,d,{perf=85,eff=90,resp=15,light=3}={})=>({id,start:day(d-1)+"T23:00:00Z",end:day(d)+"T06:00:00Z",nap:false,score_state:"SCORED",
  score:{sleep_performance_percentage:perf,sleep_efficiency_percentage:eff,respiratory_rate:resp,
    stage_summary:{total_light_sleep_time_milli:light*3600000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:3600000}}});
// Baseline days alternating HRV 50/60 (median 55, MAD 5) and RHR 50/54 (median 52, MAD 2).
function baseline(n=20,start=0){
  return Array.from({length:n},(_,k)=>rec(start+k,{hrv:k%2?60:50,rhr:k%2?54:50}));
}
const point=(est,date)=>est.points.find(p=>p.date===date);
const SD=1.4826;

// ---------- calculation ----------
test("hand-computed value: z = +1 on HRV and RHR gives 50 + 16.67 = 67",()=>{
  const t=20;
  const est=computeStressEstimate({recoveryRecords:[...baseline(),rec(t,{hrv:55-5*SD,rhr:52+2*SD})],targetDates:[day(t)]});
  const p=point(est,day(t));
  assert.equal(p.status,"ok");
  assert.equal(p.contributions.hrv_rmssd,10);
  assert.equal(p.contributions.resting_heart_rate,6.67);
  assert.equal(p.value,67);assert.equal(p.band,"elevated");
  assert.equal(p.coverage,0.6);
  // evidence = 0.36 x 20/30 + 0.24 x 20/30 = 0.4: low, never overstated.
  assert.equal(p.confidence.score,0.4);assert.equal(p.confidence.level,"low");
  assert.deepEqual(p.confidence.components.per_input.hrv_rmssd,{baseline_values:20,completeness:0.67});
  assert.equal(p.deviation.points_from_typical,17);assert.equal(p.deviation.direction,"toward_more_load");
  assert.equal(p.deviation.largest_input.z,1);
  assert.deepEqual(p.inputs_used,["hrv_rmssd","resting_heart_rate"]);
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

test("rolling personal baseline: 14 prior days estimates, 13 is insufficient, older than 30 days does not count",()=>{
  const ok=computeStressEstimate({recoveryRecords:[...baseline(MIN_BASELINE_DAYS),rec(14,{hrv:55,rhr:52})],targetDates:[day(14)]});
  assert.equal(point(ok,day(14)).status,"ok");
  assert.equal(point(ok,day(14)).baseline_days,14);
  const short=computeStressEstimate({recoveryRecords:[...baseline(13),rec(13,{hrv:55,rhr:52})],targetDates:[day(13)]});
  const p=point(short,day(13));
  assert.equal(p.status,"insufficient_baseline");
  assert.equal(p.value,null);assert.equal(p.confidence.level,"none");
  assert.equal(short.available,false);assert.equal(short.reason,"insufficient_baseline");
  const old=computeStressEstimate({recoveryRecords:[...baseline(20),rec(55,{hrv:55,rhr:52})],targetDates:[day(55)]});
  assert.equal(point(old,day(55)).status,"insufficient_baseline");
});

test("zero variance uses the scale floor and stays finite",()=>{
  const flat=Array.from({length:20},(_,k)=>rec(k,{hrv:50,rhr:50}));
  assert.equal(point(computeStressEstimate({recoveryRecords:[...flat,rec(20,{hrv:50,rhr:50})],targetDates:[day(20)]}),day(20)).value,50);
  const moved=point(computeStressEstimate({recoveryRecords:[...flat,rec(20,{hrv:49,rhr:51})],targetDates:[day(20)]}),day(20));
  assert.equal(moved.contributions.hrv_rmssd,4);
  assert.equal(moved.contributions.resting_heart_rate,6.67);
});

test("determinism: same input in any order gives the same output",()=>{
  const u=syntheticUser();
  const targetDates=u.recoveries.slice(-5).map(r=>r.created_at.slice(0,10));
  const a=computeStressEstimate({recoveryRecords:u.recoveries,sleepRecords:u.sleeps,targetDates,sleepAvailable:true});
  const b=computeStressEstimate({recoveryRecords:u.recoveries.slice().reverse(),sleepRecords:u.sleeps.slice().reverse(),targetDates:targetDates.slice().reverse(),sleepAvailable:true});
  assert.deepEqual(a,b);
});

// ---------- finding 4: magnitude vs evidence, agreement, artifacts ----------
test("F4 consistent multi-signal shift: agreeing capped inputs keep full evidence confidence",()=>{
  const u=syntheticUser();
  const out=computeStressEstimate({recoveryRecords:u.recoveries,sleepRecords:u.sleeps,
    targetDates:[u.recoveries.at(-1).created_at.slice(0,10)],sleepAvailable:true});
  const p=out.points[0];
  assert.ok(p.anomalies.length>=4);
  assert.ok(p.anomalies.every(a=>a.relation==="agrees"&&a.lowers_confidence===false));
  assert.equal(p.confidence.components.conflicts,0);
  assert.equal(p.confidence.level,"high");
  // Agreement is not proof: confidence equals evidence, never more.
  assert.ok(p.confidence.score<=p.confidence.components.input_coverage*p.confidence.components.baseline_completeness+1e-9);
  assert.ok(p.value>80);
});

test("F4 agreement is not a bonus: two agreeing capped inputs score exactly the evidence",()=>{
  const p=point(computeStressEstimate({recoveryRecords:[...baseline(30),rec(30,{hrv:12,rhr:62})],targetDates:[day(30)]}),day(30));
  assert.equal(p.anomalies.length,2);
  assert.ok(p.anomalies.every(a=>a.relation==="agrees"));
  assert.deepEqual({score:p.confidence.score,level:p.confidence.level},confidenceFor(0.6,0));
  assert.equal(p.value,100);
});

test("F4 contradictory signals: a capped input against the others lowers confidence",()=>{
  // HRV far above usual (capped toward less load) while RHR is clearly up (z = +2).
  const p=point(computeStressEstimate({recoveryRecords:[...baseline(30),rec(30,{hrv:80,rhr:52+2*2*SD})],targetDates:[day(30)]}),day(30));
  assert.equal(p.anomalies.length,1);
  assert.equal(p.anomalies[0].relation,"disagrees");
  assert.equal(p.anomalies[0].direction,"toward_less_load");
  assert.deepEqual({score:p.confidence.score,level:p.confidence.level},confidenceFor(0.6,1));
});

test("F4 isolated extreme: a lone capped outlier is scored but lowers confidence",()=>{
  const p=point(computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:5,rhr:52})],targetDates:[day(20)]}),day(20));
  assert.equal(p.contributions.hrv_rmssd,30);
  assert.equal(p.anomalies[0].relation,"lone_outlier");
  assert.equal(p.anomalies[0].scored,true);
  assert.equal(p.confidence.score,0.34); // 0.4 x 0.85
  assert.ok(p.limitations.some(l=>/capped/.test(l)&&/reduced/.test(l)));
});

test("F4 suspected artifact: an unsupported |z| >= 8 optional input is not scored; implausible values are dropped",()=>{
  const recs=Array.from({length:31},(_,k)=>rec(k,{hrv:k%2?60:50,rhr:k%2?54:50,sleepId:"s"+k}));
  const sleeps=Array.from({length:31},(_,k)=>sleepRec("s"+k,k,{resp:k%2?15:15.4}));
  sleeps[30]=sleepRec("s30",30,{resp:30}); // 15 -> 30: z far beyond 8, others typical
  const p=point(computeStressEstimate({recoveryRecords:recs,sleepRecords:sleeps,targetDates:[day(30)],sleepAvailable:true}),day(30));
  const a=p.anomalies.find(x=>x.input==="respiratory_rate");
  assert.equal(a.relation,"suspected_artifact");assert.equal(a.scored,false);
  assert.ok(!p.inputs_used.includes("respiratory_rate"));
  assert.ok(p.confidence.components.conflicts>=1);
  // Implausible HRV (outside PLAUSIBLE) is never used and the day is not estimated.
  const bad=point(computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:PLAUSIBLE.hrv_rmssd[1]+50,rhr:52})],targetDates:[day(20)]}),day(20));
  assert.equal(bad.status,"missing_required_inputs");
  assert.equal(bad.anomalies[0].relation,"implausible_value");
  // A required input as suspected artifact: no value at all.
  const art=point(computeStressEstimate({recoveryRecords:[...baseline(30),rec(30,{hrv:55,rhr:52+12*2*SD})],targetDates:[day(30)]}),day(30));
  assert.equal(art.status,"suspected_artifact");assert.equal(art.value,null);
});

// ---------- finding 5: per-input baseline completeness ----------
function fullUser(n,{sleepEvery=1,respEvery=1}={}){
  const recs=[],sleeps=[];
  for(let k=0;k<n;k++){
    const id="s"+k;
    recs.push(rec(k,{hrv:k%2?60:50,rhr:k%2?54:50,sleepId:id}));
    if(k%sleepEvery===0){
      const s=sleepRec(id,k,{perf:k%2?80:90,eff:k%2?88:92,resp:k%2?15:15.4,light:k%2?3:3.5});
      if(k%respEvery!==0)delete s.score.respiratory_rate;
      sleeps.push(s);
    }
  }
  return {recs,sleeps};
}
test("F5 full histories: all six inputs with 30 baseline values give evidence 1.0",()=>{
  const {recs,sleeps}=fullUser(31);
  const p=point(computeStressEstimate({recoveryRecords:recs,sleepRecords:sleeps,targetDates:[day(30)],sleepAvailable:true}),day(30));
  assert.equal(p.inputs_used.length,6);
  assert.equal(p.confidence.components.baseline_completeness,1);
  assert.equal(p.confidence.score,1);
});
test("F5 partially populated optional metrics lower confidence by their own completeness",()=>{
  // Sleep on 2 of every 3 nights: 20 of 30 baseline values (and the target day has sleep).
  const {recs,sleeps}=fullUser(31,{sleepEvery:1});
  const thin=sleeps.filter((s,k)=>k%3!==1||k===30);
  const p=point(computeStressEstimate({recoveryRecords:recs,sleepRecords:thin,targetDates:[day(30)],sleepAvailable:true}),day(30));
  assert.equal(p.confidence.components.per_input.sleep_performance.baseline_values,20);
  assert.equal(p.confidence.components.per_input.hrv_rmssd.baseline_values,30);
  // 0.6 + 0.4 x 20/30 = 0.8667
  assert.equal(p.confidence.score,0.87);
  assert.ok(p.limitations.some(l=>/partial 30-day baseline/.test(l)));
});
test("F5 uneven coverage: an optional input below 14 baseline values is not scored at all",()=>{
  const {recs,sleeps}=fullUser(31,{respEvery:3}); // respiratory on 10 of 30 nights
  const p=point(computeStressEstimate({recoveryRecords:recs,sleepRecords:sleeps,targetDates:[day(30)],sleepAvailable:true}),day(30));
  assert.ok(!p.inputs_used.includes("respiratory_rate"));
  assert.ok(p.inputs_missing.includes("respiratory_rate"));
  assert.equal(p.confidence.components.input_coverage,0.9);
  assert.equal(p.confidence.score,0.9);
});
test("F5 missing respiratory or sleep data: confidence falls with coverage",()=>{
  const {recs}=fullUser(31);
  const noSleep=point(computeStressEstimate({recoveryRecords:recs,targetDates:[day(30)]}),day(30));
  assert.equal(noSleep.confidence.score,0.6);assert.equal(noSleep.confidence.level,"moderate");
  assert.deepEqual(noSleep.inputs_missing.sort(),["respiratory_rate","sleep_duration","sleep_efficiency","sleep_performance"]);
});

// ---------- finding 6: requested latest vs latest valid ----------
test("F6 newest day missing: latest_valid is the earlier day and is labeled as such",()=>{
  const est=computeStressEstimate({recoveryRecords:[...baseline(),rec(20,{hrv:55,rhr:52}),rec(21,{hrv:55,rhr:null})],targetDates:[day(20),day(21)]});
  assert.equal(est.requested_latest_date,day(21));
  assert.equal(est.latest_requested.status,"missing_required_inputs");
  assert.equal(est.latest_requested.value,null);
  assert.equal(est.latest_valid.date,day(20));
  assert.equal(est.latest_valid_is_requested_latest,false);
  assert.ok(est.limitations[0].includes(day(21))&&est.limitations[0].includes(day(20)));
  assert.equal(Object.hasOwn(est,"latest"),false);
});
test("F6 insufficient current baseline and only past values valid",()=>{
  // Day 13 has 13 prior days (insufficient); a recovery 40 days earlier had a valid estimate.
  const early=[...baseline(20,-60),rec(-40,{hrv:55,rhr:52})];
  const est=computeStressEstimate({recoveryRecords:[...early,...baseline(13),rec(13,{hrv:55,rhr:52})],targetDates:[day(-40),day(13)]});
  assert.equal(est.latest_requested.status,"insufficient_baseline");
  assert.equal(est.latest_valid.date,day(-40));
  assert.equal(est.latest_valid_is_requested_latest,false);
  assert.equal(est.available,true);
});

// ---------- WHOOP mock: newest first, honors start/end, 25 per page ----------
const dateOf=(r,resource)=>resource==="sleep"?r.start:r.created_at;
function whoopFor(users,calls,{limitAt=null}={}){
  return async(db,userId,resource,env,opts)=>{
    calls.push({userId,resource,token:opts?.next_token??null,start:opts?.start??null,end:opts?.end??null});
    if(limitAt&&limitAt(resource,calls)){const e=Error("WHOOP API request failed");e.status=429;throw e;}
    const u=users[userId];
    if(!u)throw Error("no such user");
    let all=(resource==="sleep"?u.sleeps:u.recoveries).slice().reverse();
    if(opts?.start)all=all.filter(r=>dateOf(r,resource)>=opts.start);
    if(opts?.end)all=all.filter(r=>dateOf(r,resource)<opts.end);
    const offset=opts?.next_token?Number(opts.next_token):0;
    const next=offset+25<all.length?String(offset+25):null;
    return {records:all.slice(offset,offset+25),next_token:next};
  };
}
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function run(userId,users,env,calls,logs,page=null,opts={}){
  page=page||{records:users[userId].recoveries.slice(-3),next_token:null};
  const orig=console.log;console.log=(...a)=>logs.push(a.join(" "));
  try{
    return await attachSummary(page,{db:null,userId,tool:"get_recovery",env,whoopRequest:opts.whoopRequest||whoopFor(users,calls,opts),now:Date.parse("2026-10-20T00:00:00Z")});
  }finally{console.log=orig;}
}
const ON={STRESS_ESTIMATE_ENABLED:"true",AI_SUMMARY_ENABLED:"true"};

test("missing required inputs, unscored and calibrating days are not estimated",()=>{
  const records=[...baseline(),rec(20,{hrv:55,rhr:null}),rec(21,{hrv:55,rhr:52,state:"PENDING_SCORE"}),rec(22,{hrv:55,rhr:52,calibrating:true})];
  const est=computeStressEstimate({recoveryRecords:records,targetDates:[day(20),day(21),day(22)]});
  for(const d of [20,21,22])assert.equal(point(est,day(d)).status,"missing_required_inputs");
  assert.equal(est.excluded_days,2);
  assert.equal(est.available,false);
});

test("exact sleep_id matching, never by calendar day",()=>{
  const recs=Array.from({length:21},(_,k)=>rec(k,{hrv:k%2?60:50,rhr:k%2?54:50,sleepId:"s"+k}));
  const sleeps=Array.from({length:21},(_,k)=>sleepRec("s"+k,k));
  const joined=dailyInputs(recs,sleeps).days.get(day(20));
  assert.equal(joined.sleep_performance,85);assert.equal(joined.sleep_duration,5);
  assert.equal(dailyInputs([rec(20,{hrv:55,rhr:52,sleepId:"nope"})],[sleepRec("s20",20,{perf:40})]).days.get(day(20)).sleep_performance,null);
  assert.equal(dailyInputs([rec(20,{hrv:55,rhr:52})],[sleepRec("s20",20,{perf:40})]).days.get(day(20)).sleep_performance,null);
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

test("per-user isolation, and logs hold no health values or tokens",async()=>{
  const users={[A]:syntheticUser({prefix:"a"}),[B]:syntheticUser({days:10,seed:7,prefix:"b"})};
  const calls=[],logs=[];
  const a=await run(A,users,ON,calls,logs);
  const b=await run(B,users,ON,calls,logs);
  assert.ok(calls.every(c=>c.userId===A||c.userId===B));
  const sa=a.summary.chart_data.stress_estimate,sb=b.summary.chart_data.stress_estimate;
  assert.equal(sa.available,true);
  assert.equal(sb.available,false);
  assert.equal(sb.reason,"insufficient_baseline"); // genuinely insufficient, history complete
  assert.equal(sb.history.complete,true);
  const text=logs.join("\n");
  for(const r of [...users[A].recoveries,...users[B].recoveries])assert.ok(!text.includes(String(r.score.hrv_rmssd_milli)));
  assert.doesNotMatch(text,/bearer|access_token|refresh_token/i);
});

test("flag off: no estimate, no extra WHOOP calls, output unchanged",async()=>{
  const users={[A]:syntheticUser({prefix:"a"})};
  const ref=[];await run(A,users,{},ref,[]);
  for(const flag of [undefined,"false","TRUE"]){
    const calls=[];
    const out=await run(A,users,flag===undefined?{}:{STRESS_ESTIMATE_ENABLED:flag},calls,[]);
    assert.equal(out.summary.chart_data.stress_estimate,null);
    assert.equal(Object.hasOwn(out.summary.stats,"stress_estimate"),false);
    assert.deepEqual(calls,ref);
    assert.ok(calls.every(c=>c.start===null&&c.end===null));
  }
});

test("flag on with a non-recovery tool reports requires_recovery_data",async()=>{
  const out=await attachSummary({records:[{created_at:"2026-10-01T07:00:00Z",score_state:"SCORED",score:{strain:10}}],next_token:null},
    {db:null,userId:A,tool:"get_cycles",env:ON});
  const s=out.summary.chart_data.stress_estimate;
  assert.equal(s.available,false);assert.equal(s.reason,"requires_recovery_data");
});

// ---------- finding 3: bounded window, pagination, rate limits ----------
test("F3 recent history: one bounded walk per resource with WHOOP start/end",async()=>{
  const users={[A]:syntheticUser({prefix:"a"})};
  const calls=[];
  const out=await run(A,users,ON,calls,[]);
  const windowed=calls.filter(c=>c.start);
  assert.ok(windowed.some(c=>c.resource==="recovery")&&windowed.some(c=>c.resource==="sleep"));
  for(const c of windowed){assert.match(c.start,/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);assert.ok(c.end>c.start);}
  const firsts=windowed.filter(c=>c.resource==="recovery"&&c.token==null);
  assert.equal(firsts.length,1);
  assert.ok(windowed.length<=6);
  assert.equal(out.summary.chart_data.stress_estimate.history.complete,true);
});

test("F3 target records older than 150 entries are reachable",async()=>{
  const u=syntheticUser({days:220,prefix:"o",stressFrom:999});
  const users={[A]:u};
  const calls=[];
  // Target page: days 10-12 counted from the start, i.e. ~207 entries behind the newest.
  const page={records:u.recoveries.slice(40,43),next_token:null};
  const out=await run(A,users,ON,calls,[],page);
  const s=out.summary.chart_data.stress_estimate;
  assert.equal(s.history.complete,true);
  assert.deepEqual(s.points.map(p=>p.date),page.records.map(r=>r.created_at.slice(0,10)));
  assert.ok(s.points.every(p=>p.status==="ok"&&p.baseline_days===30));
  assert.ok(calls.filter(c=>c.start&&c.resource==="recovery").length<=3);
});

test("F3 pagination boundaries: exactly 25, 26 and 50 records in the window",async()=>{
  for(const n of [25,26,50]){
    const u=syntheticUser({days:n,prefix:"p"});
    const calls=[];
    const ctx={db:null,userId:A,env:ON,whoopRequest:whoopFor({[A]:u},calls)};
    const got=await fetchStressWindow(ctx,"recovery",day(0),day(n-1));
    assert.equal(got.records.length,n);
    assert.equal(got.complete,true);
    assert.equal(got.pages,Math.ceil(n/25));
  }
  // Page budget exhausted: reported incomplete, never silently complete.
  const endless=async()=>({records:[rec(1,{hrv:55,rhr:52})],next_token:"x"+Math.random().toString(36).slice(2)});
  const got=await fetchStressWindow({db:null,userId:A,env:ON,whoopRequest:endless},"recovery",day(0),day(10));
  assert.equal(got.complete,false);
});

test("F3 incomplete history is reported explicitly, and genuinely insufficient history differs",async()=>{
  const u=syntheticUser({prefix:"i"});
  const page={records:u.recoveries.slice(-3),next_token:null};
  const broken=async(db,userId,resource,env,opts)=>{
    if(resource==="recovery"&&opts?.start)throw Error("WHOOP API request failed");
    return whoopFor({[A]:u},[])(db,userId,resource,env,opts);
  };
  const out=await run(A,{[A]:u},ON,[],[],page,{whoopRequest:broken});
  const s=out.summary.chart_data.stress_estimate;
  assert.equal(s.history.complete,false);
  assert.equal(s.reason,"incomplete_history");
  assert.ok(s.points.every(p=>p.status==="incomplete_history"));
  assert.equal(s.limitations[0],STRESS_HISTORY_NOTE);
});

test("F3 a WHOOP 429 returns no estimate and a limitation note instead of failing",async()=>{
  const users={[A]:syntheticUser({prefix:"a"})};
  for(const limited of ["recovery","sleep"]){
    const calls=[];
    const out=await run(A,users,ON,calls,[],null,{limitAt:(resource,cs)=>resource===limited&&cs.at(-1).start!=null});
    const s=out.summary.chart_data.stress_estimate;
    assert.equal(s.available,false);assert.equal(s.reason,"rate_limited");
    assert.deepEqual(s.points,[]);assert.equal(s.latest_valid,null);
    assert.equal(s.limitations[0],STRESS_RATE_LIMIT_NOTE);
    assert.equal(Object.hasOwn(out.summary.stats,"stress_estimate"),false);
    assert.ok(out.summary.text.length>0);
  }
});

// ---------- finding 2: target dates only from recovery records ----------
test("F2 mixed digest records: target dates come only from recovery records; sleep matched by id",async()=>{
  const u=syntheticUser({prefix:"m"});
  const recs=u.recoveries.slice(34,41),sleeps=u.sleeps.slice(33,41); // sleep one day earlier too
  assert.deepEqual(stressTargetDates([...sleeps,...recs]),recs.map(r=>r.created_at.slice(0,10)));
  const out=await run(A,{[A]:u},ON,[],[],{records:[...sleeps,...recs],next_token:null});
  const s=out.summary.chart_data.stress_estimate;
  assert.deepEqual(s.points.map(p=>p.date),recs.map(r=>r.created_at.slice(0,10)));
  // Each sleep starts on the previous UTC date and still joins by sleep_id.
  assert.ok(sleeps.every(x=>x.start.slice(0,10)<x.end.slice(0,10)));
  assert.ok(s.points.every(p=>p.inputs_used.includes("sleep_performance")));
});

test("F2 missing sleep: sleep inputs are missing, no date is added",async()=>{
  const u=syntheticUser({prefix:"n"});
  const noSleep={...u,sleeps:u.sleeps.filter((_,k)=>k!==40)};
  const recs=u.recoveries.slice(38,41);
  const out=await run(A,{[A]:noSleep},ON,[],[],{records:recs,next_token:null});
  const p=out.summary.chart_data.stress_estimate.points.find(x=>x.date===day(40));
  assert.ok(p.inputs_missing.includes("sleep_performance"));
  assert.equal(out.summary.chart_data.stress_estimate.points.length,3);
});

test("F2 weekly digest: boundary dates, no fabricated target dates, cached output identical",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const f of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  const db={sqlite,...d1Database(sqlite)};
  try{
    const u=syntheticUser({prefix:"w"}); // day(34)=2026-10-05 Mon .. day(40)=2026-10-11 Sun
    const calls=[];
    // The estimate only exists with summaries on, so the digest runs the model path.
    // The synthetic model states the recovery median from its own input JSON.
    let modelCalls=0;
    const AI={async run(_m,input){
      modelCalls++;
      const stats=JSON.parse(input.messages[1].content).stats;
      return {response:`Recovery score median was ${stats.metrics["score.recovery_score"].median}.`};
    }};
    const env={WEEKLY_DIGEST_ENABLED:"true",AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",AI,
      AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",AI_ANALYTICS_QUERY:async()=>({neurons:0}),
      WEEKLY_DIGEST_NOW:Date.parse("2026-10-12T08:00:00Z")};
    const call=()=>handleMcpRpc({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_weekly_digest",arguments:{week_ending:"2026-10-11"}}},
      {db,userId:A,env,whoopRequest:whoopFor({[A]:u},calls)},{modern:true});
    const first=JSON.parse((await call()).result.content[0].text);
    assert.equal(first.status,"model");
    const s=first.chart_data.stress_estimate;
    const expected=Array.from({length:7},(_,k)=>day(34+k));
    assert.deepEqual(s.points.map(p=>p.date),expected);
    assert.equal(expected[0],"2026-10-05");assert.equal(expected.at(-1),"2026-10-11");
    assert.equal(s.requested_latest_date,"2026-10-11");
    const again=JSON.parse((await call()).result.content[0].text);
    assert.equal(again.cached,true);assert.equal(modelCalls,1);
    assert.deepEqual(again.chart_data.stress_estimate.points.map(p=>p.date),expected);
  }finally{sqlite.close();}
});

// ---------- finding 1 + 6: prompt and filter ----------
const plain={count:3,sources:[{source:"WHOOP",count:3}],metrics:{"score.recovery_score":{min:35,max:44,mean:40,median:40}}};
const valid={...plain,stress_estimate:{name:"WHOOP Lens experimental physiological stress estimate",experimental:true,
  estimate_date:"2026-10-15",requested_latest_date:"2026-10-15",is_latest_requested_date:true,value:72,band:"elevated",confidence:"moderate",baseline_days:30}};
const mainPrompt=readFileSync(new URL("./fixtures/system-prompt-main.txt",import.meta.url),"utf8").replace(/\n$/,"");
const STRESS_WORDS=["stress","estimate","high","low","elevated","moderate","confidence","index","experimental","physiological","band","lens"];

test("F1 feature disabled: prompt identical to main and stress words rejected",()=>{
  assert.equal(systemPromptFor(plain),mainPrompt);
  assert.equal(systemPromptFor(undefined),mainPrompt);
  for(const w of STRESS_WORDS)assert.equal(outputRejection(`Recovery score was ${w}, ranging from 35 to 44.`,plain)?.rule,"vocabulary",w);
  assert.equal(outputRejection("Recovery score ranged from 35 to 44, with a median of 40.",plain),null);
});

test("F1 enabled with no valid estimate: stats carry no estimate, prompt and filter stay main",async()=>{
  const users={[B]:syntheticUser({days:10,seed:7,prefix:"b"})};
  const out=await run(B,users,ON,[],[]);
  assert.equal(out.summary.chart_data.stress_estimate.available,false);
  assert.equal(Object.hasOwn(out.summary.stats,"stress_estimate"),false);
  assert.equal(systemPromptFor(out.summary.stats),mainPrompt);
  assert.equal(outputRejection("The stress estimate was elevated.",out.summary.stats)?.rule,"vocabulary");
});

test("F1 enabled with a valid estimate: factual sentence accepted, prompt gains the dated line",async()=>{
  const users={[A]:syntheticUser({prefix:"a"})};
  const out=await run(A,users,ON,[],[]);
  const st=out.summary.stats.stress_estimate;
  assert.ok(st&&st.value!=null);
  assert.equal(st.estimate_date,out.summary.chart_data.stress_estimate.latest_valid.date);
  const on=systemPromptFor(valid);
  assert.match(on,/estimate_date/);assert.match(on,/never call it|Never call it/);
  assert.equal(on.replace(/If stats\.stress_estimate is present[^]*?or a diagnosis\. /,""),mainPrompt);
  assert.equal(outputRejection("The WHOOP Lens experimental physiological stress estimate was 72 on 2026-10-15, in the elevated band with moderate confidence.",valid),null);
  // Neutral level words outside a stress claim stay usable; claim words must bind to the estimate.
  for(const w of ["high","low","elevated","moderate","confidence","band","experimental","physiological","lens"])
    assert.equal(outputRejection(`Recovery score was ${w}, ranging from 35 to 44.`,valid),null,w);
  for(const w of ["stress","estimate","index"])
    assert.equal(outputRejection(`Recovery score was ${w}, ranging from 35 to 44.`,valid)?.rule,"stress_claim",w);
});

test("F1 unsupported stress claims and medical wording are rejected even with a valid estimate",()=>{
  for(const t of ["The WHOOP Stress Monitor estimate was 72 on 2026-10-15.","The stress zone estimate was 72 on 2026-10-15.",
    "The stress estimate was 72, a clinical stress level.","The user was stressed, with an estimate of 72."])
    assert.equal(outputRejection(t,valid)?.rule,"stress_claim",t);
  assert.notEqual(outputRejection("The stress estimate was 72, indicating burnout.",valid),null);
  assert.equal(outputRejection("The stress estimate was 72, so you should rest.",valid).rule,"advice");
  assert.notEqual(outputRejection("The stress estimate was 72, which may indicate a diagnosis.",valid),null);
});

test("F1 invented numbers and dates are rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 90 on 2026-10-15.",valid).rule,"number");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-14.",valid).rule,"number");
  assert.equal(outputRejection("The stress estimate was 72 for 5 hours.",valid).rule,"number");
});

test("F6 AI summary uses the real dates: a past estimate cannot be attached to the requested day",async()=>{
  const past={...valid,stress_estimate:{...valid.stress_estimate,estimate_date:"2026-10-13",requested_latest_date:"2026-10-15",is_latest_requested_date:false}};
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-15.",past)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13.",past),null);
  // End to end: newest page day lacks RHR, so the model stats carry both real dates.
  const u=syntheticUser({prefix:"d"});
  const page={records:[...u.recoveries.slice(-3,-1),{...u.recoveries.at(-1),score:{...u.recoveries.at(-1).score,resting_heart_rate:null}}],next_token:null};
  const out=await run(A,{[A]:u},ON,[],[],page);
  const st=out.summary.stats.stress_estimate;
  assert.equal(st.requested_latest_date,day(44));
  assert.equal(st.estimate_date,day(43));
  assert.equal(st.is_latest_requested_date,false);
});

// ---------- round 2, finding 1: stress claims bound to the estimate ----------
const r2stats={...plain,latest_value:{metric:"score.recovery_score",date:"2026-10-14",value:44},
  metrics:{"score.recovery_score":{min:35,max:44,mean:40,median:40},"score.hrv_rmssd_milli":{min:48,max:61,mean:55,median:55}},
  stress_estimate:{...valid.stress_estimate}};
const r2past={...r2stats,stress_estimate:{...r2stats.stress_estimate,estimate_date:"2026-10-14",requested_latest_date:"2026-10-15",is_latest_requested_date:false}};
test("R2-1 wrong stress value is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 73 on 2026-10-15.",r2stats)?.rule,"number");
  assert.equal(outputRejection("The stress estimate was 72 or 40.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was elevated.",r2stats)?.rule,"stress_claim"); // no value stated
});
test("R2-1 a recovery or HRV value labeled as stress is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 40 on 2026-10-15.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress index was 55.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 44 on 2026-10-14.",r2stats)?.rule,"stress_claim");
  // The same numbers are fine in non-stress sentences.
  assert.equal(outputRejection("Recovery score median was 40.",r2stats),null);
});
test("R2-1 wrong date and wrong level words are rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-14.",r2stats)?.rule,"stress_claim"); // 10-14 exists in stats, not the estimate date
  assert.equal(outputRejection("The stress estimate was 72, in the high band.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 with low confidence.",r2stats)?.rule,"stress_claim");
});
test("R2-1 a past estimate without its date is rejected; with its date it is accepted",()=>{
  assert.equal(outputRejection("The stress estimate was 72, in the elevated band.",r2past)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-15.",r2past)?.rule,"stress_claim");
  assert.equal(outputRejection("The WHOOP Lens experimental physiological stress estimate was 72 on 2026-10-14, in the elevated band with moderate confidence.",r2past),null);
});
test("R2-1 a correctly attributed current estimate is accepted, with or without its date",()=>{
  assert.equal(outputRejection("The stress estimate was 72, in the elevated band with moderate confidence.",r2stats),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-15. Recovery score median was 40.",r2stats),null);
  // Existing safeguards still apply.
  assert.equal(outputRejection("The stress estimate was 72, so you should rest.",r2stats).rule,"advice");
  assert.equal(outputRejection("The WHOOP Stress Monitor estimate was 72.",r2stats).rule,"stress_claim");
});

// ---------- round 2, finding 2: sleep completeness ----------
async function runSleep(sleepBehavior,{noSleep=false}={}){
  const u=syntheticUser({prefix:"z"});
  if(noSleep)u.sleeps=[];
  const base=whoopFor({[A]:u},[]);
  const whoopRequest=async(db,userId,resource,env,opts)=>{
    if(resource==="sleep"&&opts?.start&&sleepBehavior)return sleepBehavior(opts,()=>base(db,userId,resource,env,opts));
    return base(db,userId,resource,env,opts);
  };
  const out=await run(A,{[A]:u},ON,[],[],null,{whoopRequest});
  return out.summary.chart_data.stress_estimate;
}
const partialChecks=s=>{
  assert.equal(s.history.complete,false);
  assert.equal(s.history.recovery_complete,true);
  assert.equal(s.history.sleep,"partial");
  assert.equal(s.method.sleep_data,"partial");
  assert.ok(s.limitations.some(l=>/partially retrieved/.test(l)));
  const p=s.points.find(x=>x.value!=null);
  assert.ok(p,"estimate still produced from recovery");
  assert.equal(p.sleep_data,"partial");
  assert.equal(p.confidence.components.sleep_history_partial,true);
  assert.ok(p.confidence.components.conflicts>=1);
};
test("R2-2 incomplete sleep pagination (page budget exhausted) is partial",async()=>{
  let n=0;
  partialChecks(await runSleep(async(opts,real)=>{const page=await real();return {...page,next_token:"more"+(++n)};}));
});
test("R2-2 an invalid sleep cursor is partial",async()=>{
  partialChecks(await runSleep(async(opts,real)=>{const page=await real();return {...page,next_token:"../bad"};}));
  partialChecks(await runSleep(async(opts,real)=>{const page=await real();return {...page,next_token:opts.next_token??"same"};}));
});
test("R2-2 a failed sleep fetch is partial, not swallowed",async()=>{
  partialChecks(await runSleep(async()=>{throw Error("WHOOP API request failed");}));
});
test("R2-2 recovery complete with sleep incomplete lowers confidence vs a complete sleep history",async()=>{
  const full=await runSleep(null);
  assert.equal(full.history.complete,true);assert.equal(full.history.sleep,"complete");
  const part=await runSleep(async()=>{throw Error("boom");});
  const d=full.latest_valid.date;
  const pf=full.points.find(p=>p.date===d),pp=part.points.find(p=>p.date===d);
  assert.ok(pp.confidence.score<pf.confidence.score);
  assert.equal(pp.confidence.components.sleep_history_partial,true);
});
test("R2-2 no sleep recorded (complete retrieval, zero records) is none_recorded, without a retrieval penalty",async()=>{
  const s=await runSleep(null,{noSleep:true});
  assert.equal(s.history.complete,true);
  assert.equal(s.history.sleep,"none_recorded");
  assert.ok(s.limitations.some(l=>/No sleep was recorded/.test(l)));
  const p=s.points.find(x=>x.value!=null);
  assert.equal(p.sleep_data,"none_recorded");
  assert.equal(p.confidence.components.sleep_history_partial,false);
  assert.equal(p.confidence.components.conflicts,0);
});

// ---------- round 2, finding 3: both flags, consistent everywhere ----------
test("R2-3 all four flag combinations agree across capabilities, host instructions and tool output",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const f of ["0001_initial.sql","0004_medical_context_review.sql","0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(A,A);
  sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(A);
  const db={sqlite,...d1Database(sqlite)};
  const u=syntheticUser({prefix:"f"});
  const rpcCall=(env,method,params,modern=true)=>handleMcpRpc({jsonrpc:"2.0",id:1,method,params},{db,userId:A,env,whoopRequest:async(d,userId,resource,e,opts)=>{
    if(opts?.limit===10&&!opts?.start&&!opts?.next_token&&resource==="recovery")return {records:u.recoveries.slice(-3),next_token:null};
    return whoopFor({[A]:u},[])(d,userId,resource,e,opts);
  }},{modern});
  try{
    for(const stress of ["true","false"])for(const summary of ["true","false"]){
      const env={STRESS_ESTIMATE_ENABLED:stress,AI_SUMMARY_ENABLED:summary,
        AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",AI_ANALYTICS_QUERY:async()=>({neurons:0})};
      const expect=stress==="true"&&summary==="true";
      const init=await rpcCall(env,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"t",version:"1"}},false);
      const discover=await rpcCall(env,"server/discover",{});
      const instructions=init.result.instructions;
      assert.equal(discover.result.instructions,instructions);
      const caps=JSON.parse((await rpcCall(env,"tools/call",{name:"get_capabilities",arguments:{}})).result.content[0].text);
      const args=summary==="true"?{summary:true}:{};
      const tool=await rpcCall(env,"tools/call",{name:"get_recovery",arguments:args});
      const data=JSON.parse(tool.result.content[0].text);
      const returned=!!data.summary?.chart_data?.stress_estimate;
      const label=`stress=${stress} summary=${summary}`;
      assert.equal(/experimental daily physiological stress index/.test(instructions),expect,label+" instructions");
      assert.equal(caps.capabilities.some(c=>c.id==="experimental-stress-estimate"),expect,label+" capabilities");
      assert.equal(returned,expect,label+" tool output");
      assert.match(instructions,/WHOOP Stress Monitor history is not in the official WHOOP developer API/);
      assert.equal(caps.capabilities.find(c=>c.id==="stress-monitor").status,"unsupported");
      if(expect)assert.equal(data.summary.chart_data.stress_estimate.experimental,true);
    }
  }finally{sqlite.close();}
});

// ---------- round 3: statements that an estimate is unavailable ----------
const r3={...r2stats,stress_estimate:{...r2stats.stress_estimate,value:72,band:"elevated",confidence:"moderate",
  estimate_date:"2026-10-13",requested_latest_date:"2026-10-15",is_latest_requested_date:false,unavailable_dates:["2026-10-15","2026-10-14"]}};
test("R3 valid past estimate plus an unavailable newer date, in separate sentences",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The stress estimate is unavailable for 2026-10-15.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, in the elevated band with moderate confidence. The estimate is not available for 2026-10-14 and 2026-10-15.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The stress estimate was insufficient for 2026-10-15.",r3),null);
});
test("R3 both dates explained correctly in one sentence",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, and 2026-10-15 has no estimate.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, while 2026-10-15 is unavailable.",r3),null);
});
test("R3 a value claimed for the unavailable date is rejected",()=>{
  for(const t of ["The stress estimate was 72 on 2026-10-15.",
    "2026-10-15 has no estimate, and the stress estimate was 72 on 2026-10-15.",
    "The stress estimate was 72 on 2026-10-13 and 72 on 2026-10-15, which has no estimate.",
    "The stress estimate is unavailable for 2026-10-15 at 72.",
    "The stress estimate was unavailable on 2026-10-13, and 72 on 2026-10-15."])
    assert.equal(outputRejection(t,r3)?.rule,"stress_claim",t);
  // Unavailable wording may name only dates without an estimate.
  assert.equal(outputRejection("The stress estimate is unavailable for 2026-10-13.",r3)?.rule,"stress_claim");
  // A level word attached to the unavailable date is a claim too.
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate and elevated band.",r3)?.rule,"stress_claim");
});
test("R3 wrong value, wrong date or wrong confidence is still rejected",()=>{
  assert.notEqual(outputRejection("The stress estimate was 73 on 2026-10-13. 2026-10-15 has no estimate.",r3),null);
  assert.equal(outputRejection("The stress estimate was 40 on 2026-10-13. 2026-10-15 has no estimate.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-14. 2026-10-15 has no estimate.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13 with low confidence, and 2026-10-15 has no estimate.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72. 2026-10-15 has no estimate.",r3)?.rule,"stress_claim"); // past value without its date
  assert.notEqual(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-16 has no estimate.",r3),null); // invented date
});
test("R3 medical-safety, advice, unsupported-claim and vocabulary rules still apply",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate, so you should rest.",r3).rule,"advice");
  assert.notEqual(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate, which may need a diagnosis.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The Stress Monitor is unavailable for 2026-10-15.",r3).rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-15 has no estimate amid zebras.",r3).rule,"vocabulary");
  // Without a valid estimate the unavailable wording is not unlocked (vocabulary identical to main).
  assert.equal(outputRejection("Recovery score was unavailable, ranging from 35 to 44.",plain)?.rule,"vocabulary");
});
test("R3 the model stats list only requested dates without a valid estimate",async()=>{
  const u=syntheticUser({prefix:"r3"});
  const page={records:[...u.recoveries.slice(-3,-1),{...u.recoveries.at(-1),score:{...u.recoveries.at(-1).score,resting_heart_rate:null}}],next_token:null};
  const out=await run(A,{[A]:u},ON,[],[],page);
  const st=out.summary.stats.stress_estimate;
  assert.deepEqual(st.unavailable_dates,[day(44)]);
  assert.equal(st.estimate_date,day(43));
  assert.equal(outputRejection(`The stress estimate was ${st.value} on ${day(43)}. ${day(44)} has no estimate.`,out.summary.stats),null);
});

// ---------- Codex review of 52eb61f (P1): the estimate value grounds only stress claims ----------
test("Codex P1 the estimate value cannot ground another metric",()=>{
  assert.equal(outputRejection("The stress estimate was 72. Recovery score was 72.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate and recovery score were 72.",r2stats)?.rule,"stress_claim");
  assert.equal(outputRejection("Recovery score median was seventy-two.",r2stats)?.rule,"stress_claim");
  // Real recovery numbers in their own sentence still pass.
  assert.equal(outputRejection("The stress estimate was 72. Recovery score median was 40.",r2stats),null);
  // If a recovery value genuinely equals 72, it is grounded by recovery itself.
  const same={...r2stats,metrics:{...r2stats.metrics,"score.recovery_score":{min:35,max:72,mean:50,median:50}}};
  assert.equal(outputRejection("The stress estimate was 72. Recovery score maximum was 72.",same),null);
});

// ---------- Codex review of d4c28b4 ----------
test("Codex2 P1-1 an undated unavailable claim is rejected",()=>{
  for(const t of ["The stress estimate was 72 on 2026-10-13. The stress estimate is unavailable.",
    "The stress estimate was 72 on 2026-10-13. A newer estimate is not available."])
    assert.equal(outputRejection(t,r3)?.rule,"stress_claim",t);
});
test("Codex2 P1-1 a real missing date is accepted; a date with a valid estimate is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The stress estimate is unavailable for 2026-10-15.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The stress estimate is unavailable for 2026-10-13.",r3)?.rule,"stress_claim");
});
test("Codex2 P1-2 a pronoun pointing to a genuinely unavailable date is accepted",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It is unavailable for 2026-10-15.",r3),null);
});
test("Codex2 P1-2 a pronoun pointing to a date with an estimate, or with no date, is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It is unavailable for 2026-10-13.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It is unavailable.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. 2026-10-13 is unavailable.",r3)?.rule,"stress_claim");
  // Since Codex3, "missing" counts as missing-data wording, so the date decides.
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It was missing on 2026-10-13.",r3)?.rule,"stress_claim");
});
test("Codex2 P1-2 a non-stress unavailable sentence follows the normal rules, and feature-off is unchanged",()=>{
  const withDates={...r3,missing_dates:["2026-10-12"]};
  // Not treated as a stress claim: it names HRV, so the normal (grounding, vocabulary) rules decide.
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. HRV data was unavailable on 2026-10-12.",withDates),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. HRV data was unavailable on 2026-10-11.",withDates)?.rule,"number");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score was missing on 2026-10-12.",withDates),
    outputRejection("Recovery score was missing on 2026-10-12.",{...withDates,stress_estimate:undefined}));
  // Feature off: the stress validator never runs; results equal main's rules.
  const off={...plain,missing_dates:["2026-10-12"]};
  assert.equal(outputRejection("It is unavailable for 2026-10-12.",off)?.rule,"vocabulary");
  assert.equal(outputRejection("Recovery score was missing on 2026-10-12.",off),null);
});

// ---------- Codex review of dbe32c1: clause classification ----------
test("Codex3 a valid mixed sentence (true recovery value plus a true unavailable date) is accepted",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40, and 2026-10-15 is unavailable.",r3),null);
});
test("Codex3 a mixed sentence with a false unavailable date is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40, and 2026-10-13 is unavailable.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40, and it was unavailable on 2026-10-13.",r3)?.rule,"stress_claim");
});
test("Codex3 an introductory date plus a pronoun pointing to a real missing date is accepted",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-15, it was unavailable.",r3),null);
});
test("Codex3 an introductory date plus a pronoun pointing to a date with an estimate is rejected",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-13, it was unavailable.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-15, it was unavailable at 72.",r3)?.rule,"stress_claim");
});
test("Codex3 'missing' with an introductory date is validated",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-15, it was missing.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-13, it was missing.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It was missing.",r3)?.rule,"stress_claim");
});
test("Codex3 an unrelated metric clause still follows the normal rules",()=>{
  const withDates={...r3,missing_dates:["2026-10-12"]};
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. HRV data was unavailable on 2026-10-12.",withDates),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. HRV data was unavailable on 2026-10-11.",withDates)?.rule,"number");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score was missing on 2026-10-12.",withDates),null);
});
test("Codex3 feature-off behavior is unchanged",()=>{
  const off={...plain,missing_dates:["2026-10-12"]};
  assert.equal(outputRejection("Recovery score was missing on 2026-10-12.",off),null);
  // Expected values recorded from main d98346f's outputRejection with the same stats.
  assert.equal(outputRejection("On 2026-10-12, it was missing.",off),null);
  assert.deepEqual(outputRejection("Recovery score median was 40, and 2026-10-12 is unavailable.",off),{rule:"vocabulary",unknown_words:1});
  assert.deepEqual(outputRejection("HRV data was unavailable on 2026-10-12.",off),{rule:"vocabulary",unknown_words:1});
  assert.deepEqual(outputRejection("The stress estimate was 40.",off),{rule:"vocabulary",unknown_words:2});
  assert.equal(systemPromptFor(off),mainPrompt);
});

// ---------- Codex review of f30e5a1: date lists in unavailable claims ----------
// r3: estimate on 2026-10-13; unavailable 2026-10-14 and 2026-10-15.
test("Codex4 a valid list of unavailable dates is accepted, in both orders",()=>{
  for(const t of ["The stress estimate was 72 on 2026-10-13. 2026-10-14 and 2026-10-15 have no estimate.",
    "The stress estimate was 72 on 2026-10-13. 2026-10-15 and 2026-10-14 have no estimate.",
    "The stress estimate was 72 on 2026-10-13. No estimate was returned for 2026-10-14 and 2026-10-15.",
    "The stress estimate was 72 on 2026-10-13. No estimate was returned for 2026-10-15, 2026-10-14."])
    assert.equal(outputRejection(t,r3),null,t);
});
test("Codex4 a list containing a date that has an estimate is rejected, in each position",()=>{
  for(const t of ["The stress estimate was 72 on 2026-10-13. 2026-10-13 and 2026-10-15 have no estimate.",
    "The stress estimate was 72 on 2026-10-13. 2026-10-15 and 2026-10-13 have no estimate.",
    "The stress estimate was 72 on 2026-10-13. 2026-10-14, 2026-10-13 and 2026-10-15 have no estimate.",
    "The stress estimate was 72 on 2026-10-13. No estimate was returned for 2026-10-13, 2026-10-14 and 2026-10-15.",
    "The stress estimate was 72 on 2026-10-13. No estimate was returned for 2026-10-14, 2026-10-13 and 2026-10-15.",
    "The stress estimate was 72 on 2026-10-13. No estimate was returned for 2026-10-14, 2026-10-15 and 2026-10-13."])
    assert.equal(outputRejection(t,r3)?.rule,"stress_claim",t);
});
test("Codex4 an unavailable list mixed with a separate true stress value clause is accepted",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, and 2026-10-14 and 2026-10-15 have no estimate.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, and on 2026-10-15, it was unavailable.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13, and 2026-10-14 and 2026-10-13 have no estimate.",r3)?.rule,"stress_claim");
});
const MAIN_OFF={list:{rule:"vocabulary",unknown_words:1},metric:null};
test("Codex4 feature-off behavior matches main for date lists",()=>{
  const off={...plain,missing_dates:["2026-10-12","2026-10-11"]};
  // Expected values recorded from main d98346f with the same stats.
  assert.deepEqual(outputRejection("2026-10-12 and 2026-10-11 have no estimate.",off),MAIN_OFF["list"]);
  assert.deepEqual(outputRejection("Recovery score was missing on 2026-10-12 and 2026-10-11.",off),MAIN_OFF["metric"]);
});



// ---------- Codex review of 068ac98: measurement pronouns and cache flags ----------
test("Codex5 a pronoun follow-up cannot assign recovery numbers to the stress estimate",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It was 40 on 2026-10-13.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It was 72 on 2026-10-15.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. It was 72 on 2026-10-13.",r3),null);
});
test("Codex6 date-led pronoun continuations remain bound to stress",()=>{
  for(const sentence of [
    "On 2026-10-13, it was 40.",
    "For 2026-10-13, this was 40.",
    "As of 2026-10-13, it was 40.",
    "However, it was 40.",
    "On 2026-10-15, it was 72."
  ]){
    const result=outputRejection("The stress estimate was 72 on 2026-10-13. "+sentence,r3);
    assert.equal(result?.rule,"stress_claim",sentence);
  }
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On 2026-10-13, it was 72.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40. On 2026-10-13, it was 40.",r3),null);
});

test("Codex7 natural date-led and unqualified numeric follow-ups cannot use recovery values",()=>{
  for(const sentence of [
    "On the date 2026-10-13, it was 40.",
    "On that date, it was 40.",
    "During 2026-10-13, this was 40.",
    "As of the date 2026-10-13, it was 40.",
    "After the measurement on 2026-10-13, it was 40.",
    "On the date 2026-10-13, the value was 40.",
    "The number was 40 on 2026-10-13.",
    "On 2026-10-15, the value was 72."
  ]){
    assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. "+sentence,r3)?.rule,"stress_claim",sentence);
  }
  // Matching value and date must reach ordinary vocabulary checks, not fail stress binding.
  for(const sentence of [
    "On the date 2026-10-13, it was 72.",
    "As of the date 2026-10-13, this was 72.",
    "During 2026-10-13, the value was 72."
  ]){
    assert.notEqual(outputRejection("The stress estimate was 72 on 2026-10-13. "+sentence,r3)?.rule,"stress_claim",sentence);
  }
  // An implied date is still insufficient for a historical estimate.
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. On that date, this was 72.",r3)?.rule,"stress_claim");
  // An explicit change of metric breaks stress pronoun context.
  assert.notEqual(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40. On the date 2026-10-13, it was 40.",r3)?.rule,"stress_claim");
});

test("Codex8 neutral sentences preserve the prior stress context",()=>{
  const start="The stress estimate was 72 on 2026-10-13.";
  for(const neutral of ["The data was complete.","The records were returned."]){
    for(const followUp of [
      "It was 40 on 2026-10-13.",
      "On the date 2026-10-13, it was 40.",
      "On the date 2026-10-13, the value was 40.",
      "It was 72 on 2026-10-15."
    ]){
      const sentence=start+" "+neutral+" "+followUp;
      assert.equal(outputRejection(sentence,r3)?.rule,"stress_claim",sentence);
    }
    assert.equal(outputRejection(start+" "+neutral+" It was 72 on 2026-10-13.",r3),null);
  }
});

test("Codex8 only an explicit other metric resets neutral-sentence context",()=>{
  assert.equal(outputRejection("Recovery score median was 40. The data was complete. It was 40 on 2026-10-13.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40, and the data was complete. It was 40 on 2026-10-13.",r3),null);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. The stress estimate is unavailable for 2026-10-15, and the data was complete. It was 40 on 2026-10-13.",r3)?.rule,"stress_claim");
});

test("Codex9 generic metric vocabulary cannot clear the stress referent",()=>{
  const stress="The stress estimate was 72 on 2026-10-13.";
  const neutrals=[
    "The records were returned at the same rate.",
    "The performance data was complete.",
    "The score data was complete.",
    "The recovery records were returned.",
    "The sleep data was complete.",
    "The HRV data was complete.",
    "The recovery score data was complete.",
    "The sleep performance data was complete.",
    "The recovery average data was complete."
  ];
  for(const neutral of neutrals){
    const misleading=stress+" "+neutral+" It was 40 on 2026-10-13.";
    const accurate=stress+" "+neutral+" It was 72 on 2026-10-13.";
    assert.equal(outputRejection(misleading,r3)?.rule,"stress_claim",misleading);
    assert.equal(outputRejection(accurate,r3),null,accurate);
  }
});
test("Codex9 explicit other measurements still switch context",()=>{
  const stress="The stress estimate was 72 on 2026-10-13.";
  assert.equal(outputRejection(stress+" Recovery score median was 40. It was 40 on 2026-10-13.",r3),null);
  // Four sentences correctly fail the 3-sentence response contract, but must not fail stress grounding.
  assert.notEqual(outputRejection(stress+" The records were returned at the same rate. Recovery score median was 40. It was 40 on 2026-10-13.",r3)?.rule,"stress_claim");
  assert.equal(outputRejection(stress+" Recovery score median was 40, and the records were returned at the same rate. It was 40 on 2026-10-13.",r3),null);
});

test("Codex10 mixed clauses cannot shield a contradictory inherited stress value",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  const failures=[
    "It was 40 on 2026-10-13, while recovery score median was 40.",
    "On 2026-10-13, it was 40, while recovery score median was 40.",
    "It was 40 on 2026-10-13, and recovery score median was 40.",
    "It was 40 on 2026-10-13; recovery score median was 40.",
    "It was 40 on 2026-10-13, but recovery score median was 40.",
    "On the date 2026-10-13, it was 40, whereas recovery score median was 40.",
    "It was 72 on 2026-10-15, while recovery score median was 40.",
    "The value was 40 on 2026-10-13, while recovery score median was 40.",
    "It was 40 on 2026-10-13 because recovery score was 40.",
    "It was 40 on 2026-10-13 since recovery score was 40.",
    "It was 40 on 2026-10-13 when recovery score was 40."
  ];
  for(const continuation of failures){
    const text=lead+" "+continuation;
    assert.equal(outputRejection(text,r3)?.rule,"stress_claim",text);
  }
  // A true inherited stress measurement is not rejected merely because a
  // later clause reports a separate, independently grounded recovery value.
  for(const continuation of [
    "It was 72 on 2026-10-13, while recovery score median was 40.",
    "On 2026-10-13, it was 72, and recovery score median was 40."
  ]){
    const text=lead+" "+continuation;
    assert.equal(outputRejection(text,r3),null,text);
  }
});
test("Codex10 clause-order context and neutral clauses are checked before metric resets",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  const examples=[
    "The data was complete, and it was 40 on 2026-10-13, while recovery score median was 40.",
    "The records were returned at the same rate, and it was 40 on 2026-10-13.",
    "The data was complete, but it was 40 on 2026-10-13."
  ];
  for(const rest of examples)
    assert.equal(outputRejection(lead+" "+rest,r3)?.rule,"stress_claim",rest);
  assert.equal(outputRejection(lead+" Recovery score median was 40, while it was 40 on 2026-10-13.",r3),null);
});
test("Codex10 unmeasured metric mentions with a record count cannot reset stress",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  for(const rest of [
    "The recovery score data contained 40 records. It was 40 on 2026-10-13.",
    "The sleep data included 40 records. It was 40 on 2026-10-13.",
    "The recovery records totaled 40. It was 40 on 2026-10-13."
  ])assert.equal(outputRejection(lead+" "+rest,r3)?.rule,"stress_claim",rest);
});

test("Codex10 true stress prefixes and explicit metric switches are still grounded",()=>{
  const start="The stress estimate was 72 on 2026-10-13.";
  assert.notEqual(outputRejection(start+" It was 72 on 2026-10-13 because recovery score median was 40.",r3)?.rule,"stress_claim");
  assert.notEqual(outputRejection(start+" On 2026-10-13, recovery score median was 40. It was 40.",r3)?.rule,"stress_claim");
});
test("Codex11 label-only stress continuations bind separately to band and confidence",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  for(const t of ["The band was high.","The confidence was high.","The confidence was elevated.",
    "The band was moderate.","The band was low.","The confidence level was elevated."]){
    assert.equal(outputRejection(lead+" "+t,r3)?.rule,"stress_claim",t);
  }
  for(const t of ["The band was elevated.","The confidence was moderate.",
    "The confidence level was moderate."]){
    assert.notEqual(outputRejection(lead+" "+t,r3)?.rule,"stress_claim",t);
  }
  assert.equal(outputRejection(lead+" The band was elevated on 2026-10-15.",r3)?.rule,"stress_claim");
});
test("Codex11 band and confidence must not cross-authorize levels",()=>{
  for(const t of [
    "The stress estimate was 72 on 2026-10-13 in the moderate band.",
    "The stress estimate was 72 on 2026-10-13 with elevated confidence.",
    "The stress estimate was 72 on 2026-10-13 in the high band with moderate confidence.",
    "The stress estimate was 72 on 2026-10-13 in the elevated band with high confidence."
  ])assert.equal(outputRejection(t,r3)?.rule,"stress_claim",t);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13 in the elevated band with moderate confidence.",r3),null);
});
test("Codex11 spelled-out stress continuations cannot be laundered by recovery values",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  for(const t of [
    "It was forty on 2026-10-13 then recovery score was 40.",
    "The value was forty on 2026-10-13 then recovery score was 40.",
    "It was forty on 2026-10-13.",
    "The value was forty on 2026-10-13.",
    "It was seventy-two on 2026-10-15 then recovery score was 40."
  ])assert.equal(outputRejection(lead+" "+t,r3)?.rule,"stress_claim",t);
  assert.notEqual(outputRejection(lead+" It was seventy-two on 2026-10-13 then recovery score was 40.",r3)?.rule,"stress_claim");
});
test("Codex11 missing-data clauses cannot shield inherited stress contradictions",()=>{
  const lead="The stress estimate was 72 on 2026-10-13.";
  for(const t of [
    "It was 40 on 2026-10-13, but recovery score was missing on 2026-10-15.",
    "It was forty on 2026-10-13, and recovery score was missing on 2026-10-15.",
    "The band was high, and recovery score was missing on 2026-10-15."
  ])assert.equal(outputRejection(lead+" "+t,r3)?.rule,"stress_claim",t);
});

test("Codex12 reject false stress semantics despite matching numeric and label tokens",()=>{
  for(const claim of [
    "The stress estimate was not 72 on 2026-10-13.",
    "The stress estimate was below 72 on 2026-10-13.",
    "The stress estimate was above 72 on 2026-10-13.",
    "The stress estimate was 72 percent on 2026-10-13.",
    "The stress estimate was 72 points on 2026-10-13.",
    "The stress estimate was approximately 72 on 2026-10-13.",
    "The stress estimate was 72 on 2026-10-13. The band was not elevated.",
    "The stress estimate was 72 on 2026-10-13. The confidence was 72 on 2026-10-13.",
    "The stress estimate was 72 on 2026-10-13. The band was 72 on 2026-10-13.",
    "The stress estimate was 72 on 2026-10-13. The confidence was below moderate."
  ])assert.equal(outputRejection(claim,r3)?.rule,"stress_claim",claim);
  for(const claim of [
    "The stress estimate was 72 on 2026-10-13.",
    "The stress estimate was 72 on 2026-10-13 in the elevated band with moderate confidence.",
    "The stress estimate was 72 on 2026-10-13. The band was elevated.",
    "The stress estimate was 72 on 2026-10-13. The confidence was moderate."
  ])assert.equal(outputRejection(claim,r3),null,claim);
  assert.equal(outputRejection("Recovery score median was 40.",r3),null);
});
test("Codex12 transient baseline failures cannot poison a weekly digest cache",async()=>{
  for(const [failedResource,failStatus] of [["recovery",429],["sleep",429],["sleep",500]]){
    const sqlite=new DatabaseSync(":memory:");
    for(const f of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
      sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
    const db={sqlite,...d1Database(sqlite)},week="2026-10-11";
    const u=syntheticUser({prefix:"transient12"});
    const upstream=whoopFor({[A]:u},[]);
    let remaining=1,modelCalls=0;
    const whoopRequest=async(db,id,resource,env,opts)=>{
      if(remaining>0&&resource===failedResource&&opts?.start&&
         opts.start.slice(0,10)<"2026-10-04"){
        remaining--;
        const err=Error("transient baseline failure");
        err.status=failStatus;throw err;
      }
      return upstream(db,id,resource,env,opts);
    };
    const AI={async run(_model,input){
      modelCalls++;
      const stats=JSON.parse(input.messages[1].content).stats;
      return {response:`Recovery score median was ${stats.metrics["score.recovery_score"].median}.`};
    }};
    const env={WEEKLY_DIGEST_ENABLED:"true",AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",
      AI,AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",
      AI_ANALYTICS_QUERY:async()=>({neurons:0})};
    const request=()=>buildWeeklyDigest({db,userId:A,env,whoopRequest,weekEnding:week,
      now:Date.parse("2026-10-12T08:00:00Z")});
    try{
      const first=await request();
      assert.equal(first.ok,true);
      assert.equal(first.cached,false);
      assert.equal(first.status,"model");
      assert.equal(first.chart_data.stress_estimate.history.complete,false);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_weekly_digest").get().n,0);
      const retry=await request();
      assert.equal(retry.ok,true);
      assert.equal(retry.cached,false);
      assert.equal(retry.chart_data.stress_estimate.history.complete,true);
      const cached=await request();
      assert.equal(cached.cached,true);
      assert.equal(modelCalls,2);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_weekly_digest").get().n,1);
    }finally{sqlite.close();}
  }
});

test("Codex13 reject five P1 semantic bypasses regardless of claim ordering",()=>{
  const start="The stress estimate was 72 on 2026-10-13.";
  for(const rest of [
    "There was no elevated band.",
    "The band was not elevated.",
    "The stress estimate rose to 72 on 2026-10-13.",
    "The stress estimate fell to 72 on 2026-10-13.",
    "The stress estimate increased to 72 on 2026-10-13.",
    "The stress estimate was 72 per minute on 2026-10-13.",
    "The stress estimate was 72 per day on 2026-10-13.",
    "The stress estimate was 72 beats on 2026-10-13.",
    "The confidence value was 72 on 2026-10-13.",
    "The confidence reading was 72 on 2026-10-13.",
    "The band value was 72 on 2026-10-13.",
    "The band reading was 72 on 2026-10-13."
  ])assert.equal(outputRejection(start+" "+rest,r3)?.rule,"stress_claim",rest);
  for(const first of [
    "The confidence was high.",
    "The band was high.",
    "The band was moderate.",
    "There was no elevated band.",
    "The confidence value was 72 on 2026-10-13."
  ])assert.equal(outputRejection(first+" "+start,r3)?.rule,"stress_claim",first);
});
test("Codex13 valid categorical claims remain valid in either order",()=>{
  const stress="The stress estimate was 72 on 2026-10-13.";
  for(const sentence of [
    stress,
    "The confidence was moderate. "+stress,
    "The band was elevated. "+stress,
    stress+" The band was elevated.",
    stress+" The confidence was moderate.",
    stress+" The band was elevated on 2026-10-13."
  ])assert.equal(outputRejection(sentence,r3),null,sentence);
  assert.equal(outputRejection("Recovery score median was 40.",r3),null);
  assert.equal(outputRejection("The stress estimate is unavailable for 2026-10-15.",r3),null);
});

test("Tenant isolation: two signed-in users keep distinct stress digest data and caches",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const file of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+file,import.meta.url),"utf8"));
  const db={sqlite,...d1Database(sqlite)},week="2026-10-11",calls=[];
  const alpha=syntheticUser({prefix:"tenant-alpha"});
  const beta=syntheticUser({prefix:"tenant-beta"});
  beta.recoveries=beta.recoveries.map(row=>({...row,score:{...row.score,recovery_score:95}}));
  const whoopRequest=whoopFor({[A]:alpha,[B]:beta},calls);
  let modelCalls=0;
  const AI={async run(_model,input){
    modelCalls++;
    const stats=JSON.parse(input.messages[1].content).stats;
    return {response:`Recovery score median was ${stats.metrics["score.recovery_score"].median}.`};
  }};
  const env={AI,AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",WEEKLY_DIGEST_ENABLED:"true",
    AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",
    AI_ANALYTICS_QUERY:async()=>({neurons:0})};
  const request=id=>buildWeeklyDigest({db,userId:id,env,whoopRequest,weekEnding:week,now:Date.parse("2026-10-12T08:00:00Z")});
  try{
    assert.notEqual(digestCacheScope(A,env),digestCacheScope(B,env));
    const firstA=await request(A);
    const firstB=await request(B);
    assert.equal(firstA.ok,true);
    assert.equal(firstB.ok,true);
    assert.equal(firstA.cached,false);
    assert.equal(firstB.cached,false);
    assert.notEqual(firstA.text,firstB.text);
    assert.match(firstB.text,/95/);
    assert.ok(!firstA.text.includes("95"));
    assert.ok(calls.some(c=>c.userId===A));
    assert.ok(calls.some(c=>c.userId===B));
    assert.equal(modelCalls,2);
    assert.equal((await request(A)).cached,true);
    assert.equal((await request(B)).cached,true);
    assert.equal(modelCalls,2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_weekly_digest WHERE state='ready'").get().n,2);
  }finally{sqlite.close();}
});

test("Codex15 independently calculated stress index is never attributed to WHOOP",()=>{
  const falseAttribution=[
    "The stress estimate from WHOOP was 72 on 2026-10-13.",
    "The WHOOP physiological stress estimate was 72 on 2026-10-13.",
    "The WHOOP stress estimate was 72 on 2026-10-13.",
    "The stress estimate was provided by WHOOP on 2026-10-13 at 72.",
    "WHOOP's stress estimate was 72 on 2026-10-13."
  ];
  for(const claim of falseAttribution)
    assert.equal(outputRejection(claim,r3)?.rule,"stress_claim",claim);
  for(const claim of [
    "The WHOOP Lens experimental physiological stress estimate was 72 on 2026-10-13, in the elevated band with moderate confidence.",
    "The stress estimate was 72 on 2026-10-13.",
    "The stress estimate was 72 on 2026-10-13. Recovery score median was 40."
  ])assert.equal(outputRejection(claim,r3),null,claim);
});
test("Codex15 a single dated index cannot substantiate stress aggregations",()=>{
  const unsupported=[
    "The stress estimate averaged 72 on 2026-10-13.",
    "The minimum stress estimate was 72 on 2026-10-13.",
    "The maximum stress estimate was 72 on 2026-10-13.",
    "The stress estimate ranged from 72 to 72 on 2026-10-13.",
    "The average stress estimate was 72 on 2026-10-13.",
    "The stress estimate was a mean of 72 on 2026-10-13.",
    "The stress estimate median was 72 on 2026-10-13.",
    "The stress estimate totaled 72 on 2026-10-13."
  ];
  for(const claim of unsupported)
    assert.equal(outputRejection(claim,r3)?.rule,"stress_claim",claim);
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13.",r3),null);
  assert.equal(outputRejection("Recovery score median was 40.",r3),null);
  // Feature-off vocabulary still excludes these experimental stress terms.
  assert.equal(outputRejection("The stress estimate averaged 72 on 2026-10-13.",plain)?.rule,"number");
});

test("Codex14 modified category claims and ungrounded trends reject in either order",()=>{
  const actual="The stress estimate was 72 on 2026-10-13.";
  const bad=[
    "Overall confidence was high.",
    "The overall confidence was high.",
    "Current confidence remained high.",
    "There was no overall elevated band.",
    "There was no current elevated band.",
    "The latest band was moderate.",
    "The stress estimate peaked at 72 on 2026-10-13.",
    "The stress estimate stayed at 72 on 2026-10-13.",
    "The stress estimate remained at 72 on 2026-10-13.",
    "The stress estimate was steady at 72 on 2026-10-13.",
    "The stress estimate reached 72 on 2026-10-13.",
    "The stress estimate was unchanged at 72 on 2026-10-13."
  ];
  for(const statement of bad){
    for(const whole of [statement+" "+actual,actual+" "+statement]){
      const result=outputRejection(whole,r3);
      assert.equal(result?.rule,"stress_claim",whole);
    }
  }
  for(const statement of [
    "Overall confidence was moderate.",
    "The overall band was elevated.",
    "The latest band was elevated."
  ]){
    assert.equal(outputRejection(statement+" "+actual,r3),null,statement);
    assert.equal(outputRejection(actual+" "+statement,r3),null,statement);
  }
  // Some otherwise correctly grounded wording is still intentionally blocked
  // by the separate vocabulary filter. It must not be misattributed to stress.
  assert.notEqual(outputRejection("Current confidence was moderate. "+actual,r3)?.rule,"stress_claim");
  // Similar words about ordinary recovery data must remain independent.
  assert.equal(outputRejection("Recovery score median was 40.",r3),null);
});
test("Codex14 fully fetched sleep-only weeks cache without repeat AI quota",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const file of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+file,import.meta.url),"utf8"));
  const db={sqlite,...d1Database(sqlite)},week="2026-10-11";
  const user=syntheticUser({prefix:"sleep-only14"});
  user.recoveries=[];
  const calls=[],whoopRequest=whoopFor({[A]:user},calls);
  let modelCalls=0;
  const AI={async run(_m,input){
    modelCalls++;
    const stats=JSON.parse(input.messages[1].content).stats;
    return {response:`${stats.count} WHOOP records were returned.`};
  }};
  const env={AI,AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",WEEKLY_DIGEST_ENABLED:"true",
    AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",
    AI_ANALYTICS_QUERY:async()=>({neurons:0})};
  const request=()=>buildWeeklyDigest({db,userId:A,env,whoopRequest,weekEnding:week,now:Date.parse("2026-10-12T08:00:00Z")});
  try{
    const first=await request();
    assert.equal(first.ok,true);
    assert.equal(first.cached,false);
    assert.equal(first.status,"model");
    assert.equal(first.chart_data.stress_estimate?.reason,"requires_recovery_data");
    assert.ok(calls.some(c=>c.resource==="sleep"));
    assert.equal(modelCalls,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_weekly_digest WHERE state='ready'").get().n,1);
    const second=await request();
    assert.equal(second.ok,true);
    assert.equal(second.cached,true);
    assert.deepEqual(second.chart_data.stress_estimate,first.chart_data.stress_estimate);
    assert.equal(modelCalls,1);
  }finally{sqlite.close();}
});

test("Codex5 an explicit recovery sentence resets the pronoun referent; feature off is unchanged",()=>{
  assert.equal(outputRejection("The stress estimate was 72 on 2026-10-13. Recovery score median was 40. It was 40.",r3),null);
  const off={...plain,missing_dates:["2026-10-12"]};
  assert.equal(outputRejection("Recovery score median was 40. It was 40.",off),null);
});

test("Codex5 weekly digest caches never cross AI/stress feature states, including legacy cached results",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const f of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0011_ai_weekly_digest.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  const db={sqlite,...d1Database(sqlite)},week="2026-10-11";
  const user=syntheticUser({prefix:"cache5"});
  const whoopRequest=whoopFor({[A]:user},[]);
  let modelCalls=0;
  const AI={async run(_m,input){
    modelCalls++;
    const stats=JSON.parse(input.messages[1].content).stats;
    return {response:`Recovery score median was ${stats.metrics["score.recovery_score"].median}.`};
  }};
  const base={WEEKLY_DIGEST_ENABLED:"true",AI,
    AI_ANALYTICS_ACCOUNT_ID:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token",
    AI_ANALYTICS_QUERY:async()=>({neurons:0})};
  const on={...base,AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true"};
  const off={...base,AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"false"};
  const noAi={...base,AI_SUMMARY_ENABLED:"false",STRESS_ESTIMATE_ENABLED:"true"};
  const request=env=>buildWeeklyDigest({db,userId:A,env,whoopRequest,weekEnding:week,now:Date.parse("2026-10-12T08:00:00Z")});
  // An old row created before feature-aware cache keys must never be read.
  const legacy=JSON.stringify({kind:"weekly_digest",week_ending:week,period:{start:"2026-10-05",end:week},
    text:"The stress estimate was 72 on 2026-10-11.",
    chart_data:{stress_estimate:{available:true,value:72}},insights:[],status:"model"});
  sqlite.prepare("INSERT INTO ai_weekly_digest(scope,week_ending,state,body,created_at) VALUES(?,?,'ready',?,?)")
    .run("user:"+A,week,legacy,Date.now());
  try{
    assert.notEqual(digestCacheScope(A,on),digestCacheScope(A,off));
    assert.notEqual(digestCacheScope(A,on),digestCacheScope(A,noAi));
    const a=await request(on);
    assert.equal(a.ok,true);assert.equal(a.cached,false);
    assert.ok(a.chart_data.stress_estimate?.experimental);
    assert.equal((await request(on)).cached,true);
    const b=await request(off);
    assert.equal(b.ok,true);assert.equal(b.cached,false);
    assert.equal(b.chart_data.stress_estimate,null);
    assert.doesNotMatch(b.text,/stress estimate/i);
    assert.equal((await request(off)).cached,true);
    const c=await request(noAi);
    assert.equal(c.ok,true);assert.equal(c.cached,false);
    assert.equal(c.chart_data.stress_estimate,null);
    assert.doesNotMatch(c.text,/stress estimate/i);
    assert.equal((await request(noAi)).cached,true);
    assert.equal((await request(on)).cached,true);
    assert.equal(modelCalls,2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_weekly_digest").get().n,4);
  }finally{sqlite.close();}
});
