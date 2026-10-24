// Does normal historical analysis fit the per-member WHOOP request limits?
// One synthetic member with a year of WHOOP data, the full migration chain
// (0001-0016), the real callWhoop + member budget, and a fake WHOOP that
// honours limit/nextToken/start/end. Reads every history endpoint to the end
// with auto_page, then a recovery summary with the stress estimate. No real data.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {d1Database} from "./d1-sqlite.mjs";
import {baseEnv,connect,member} from "./audit-fixtures.mjs";
import {syntheticUser} from "./stress-fixture-data.mjs";
import {callWhoop} from "../src/whoop-api.mjs";
import {createStagingRouter} from "../src/router.mjs";
import {DEFAULT_MEMBER_LIMITS} from "../src/member-rate-limit.mjs";

const OWNER=member(51);
const DAYS=365;
function database(){
  const sqlite=new DatabaseSync(":memory:");
  for(const f of readdirSync(new URL("../migrations/",import.meta.url)).filter(f=>f.endsWith(".sql")).sort())
    sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
// A year: one recovery, sleep and cycle per day, a workout on 5 of 7 days.
function year(){
  const {recoveries,sleeps}=syntheticUser({days:DAYS,stressFrom:DAYS-5,prefix:"y"});
  const cycles=recoveries.map((r,i)=>({id:r.cycle_id,created_at:r.created_at,start:sleeps[i].start,score_state:"SCORED",score:{strain:8+(i%7)}}));
  const workouts=recoveries.filter((_,i)=>i%7<5).map((r,i)=>({id:"w"+i,created_at:r.created_at,start:r.created_at,end:r.created_at,score_state:"SCORED",score:{strain:10}}));
  return {recovery:recoveries,sleep:sleeps,cycle:cycles,"activity/workout":workouts,"activity/sleep":sleeps};
}
function fakeWhoop(data){
  const calls=[];
  const fetch=async raw=>{
    const url=new URL(raw);
    const path=url.pathname.replace("/developer/v2/","");
    calls.push(path);
    let all=(data[path]||[]).slice().reverse();
    const at=r=>path==="activity/sleep"?r.start:r.created_at;
    const start=url.searchParams.get("start"),end=url.searchParams.get("end");
    if(start)all=all.filter(r=>at(r)>=start);
    if(end)all=all.filter(r=>at(r)<end);
    const limit=Number(url.searchParams.get("limit")||10),offset=Number(url.searchParams.get("nextToken")?atob(url.searchParams.get("nextToken")):0);
    const next=offset+limit<all.length?btoa(String(offset+limit)):null;
    return new Response(JSON.stringify({records:all.slice(offset,offset+limit),next_token:next}),{status:200,headers:{"content-type":"application/json"}});
  };
  return {calls,fetch};
}

test("historical analysis: a year of all four histories plus a summary with stress estimate fits 25/min and 1,000/day",async()=>{
  const d=database();
  try{
    d.sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(OWNER,OWNER);
    d.sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(OWNER);
    await connect(d.sqlite,OWNER,"public","access-"+OWNER);
    const w=fakeWhoop(year());
    const clock={t:Date.parse("2026-10-18T19:00:00Z")};
    const route=createStagingRouter({verifyIdentity:async r=>r.headers.get("x-synthetic-member"),
      whoopRequest:(db,userId,resource,env,opts)=>callWhoop(db,userId,resource,env,opts,{fetcher:w.fetch,now:()=>clock.t})});
    const env={...baseEnv,AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",DB:d};
    const call=async(name,args)=>{
      const log=console.log;console.log=()=>{};
      try{
        const r=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{"content-type":"application/json",
          accept:"application/json, text/event-stream",authorization:"Bearer synthetic","x-synthetic-member":OWNER,
          "mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},
          body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env);
        return (await r.json()).result;
      }finally{console.log=log;}
    };
    const report={};let waits=0,waited=0;
    // Each tool call: auto_page until complete. On a member 429, wait the
    // advertised Retry-After (simulated clock) and resume with the cursor.
    for(const [tool,expected] of [["get_recovery",DAYS],["get_sleep",DAYS],["get_cycles",DAYS],["get_workouts",261]]){
      const before=w.calls.length;let token=null,records=0,calls=0;
      for(;;){
        const result=await call(tool,token?{auto_page:true,next_token:token}:{auto_page:true});calls++;
        if(result.isError){
          const m=/Wait about (\d+) seconds/.exec(result.content[0].text);
          assert.ok(m,result.content[0].text);
          waits++;waited+=Number(m[1]);clock.t+=Number(m[1])*1000;continue;
        }
        const out=result.structuredContent??JSON.parse(result.content[0].text);
        records+=out.records.length;
        if(out.incomplete_reason==="rate_limited"){
          assert.equal(out.rate_limit_scope,"member");assert.ok(out.next_token,"a minute limit keeps the cursor");
          waits++;waited+=out.retry_after_seconds;clock.t+=out.retry_after_seconds*1000;
        }
        if(out.complete){break;}
        token=out.next_token;assert.ok(token);
        clock.t+=2000; // a client turn between calls
      }
      assert.equal(records,expected,tool+" complete, no gaps or duplicates");
      report[tool]={records,whoop_requests:w.calls.length-before,tool_calls:calls};
    }
    const before=w.calls.length;
    const summary=await call("get_recovery",{limit:25,summary:true});
    assert.notEqual(summary.isError,true,JSON.stringify(summary).slice(0,300));
    const s=summary.structuredContent??JSON.parse(summary.content[0].text);
    assert.ok(s.summary,"summary attached");
    const stress=s.summary.chart_data.stress_estimate;
    assert.equal(stress.available,true,JSON.stringify(stress).slice(0,300));
    assert.equal(stress.history.complete,true);
    report.summary_with_stress={whoop_requests:w.calls.length-before};
    const total=w.calls.length;
    report.total={whoop_requests:total,member_limit_waits:waits,seconds_waited:waited,
      share_of_daily_limit:`${total}/${DEFAULT_MEMBER_LIMITS.perDay}`};
    console.log("HISTORICAL_ANALYSIS_BUDGET "+JSON.stringify(report));
    assert.ok(total<DEFAULT_MEMBER_LIMITS.perDay/5,"a full one-year analysis uses well under the daily share");
    const day=d.sqlite.prepare("SELECT day_count FROM whoop_member_request_budget WHERE user_id=?").get(OWNER).day_count;
    assert.equal(day,total,"every WHOOP request was counted once");
  }finally{d.close();}
});
