// Post-deploy audit (after PR #63) regression tests. Synthetic members, fake
// WHOOP, fake AI and synthetic Health Connect payloads only.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {fixture,fakeWhoop,setup,content,member,connect,TOTAL,ENDPOINTS,baseEnv} from "./audit-fixtures.mjs";
import {sealCursor,CURSOR_TTL_MS} from "../src/history-pagination.mjs";
import {callWhoop,retryAfterSeconds} from "../src/whoop-api.mjs";
import {createStagingRouter} from "../src/router.mjs";
import {collectHistoryPages,fetchStressWindow,attachSummary} from "../src/ai-summary.mjs";
import {d1Database} from "./d1-sqlite.mjs";
import {handleMcpRpc} from "../src/mcp.mjs";
import {healthConnectWebhook,ISSUE_CONSENT} from "../src/health-connect-webhook.mjs";

const A=member(1),B=member(2);
const quietly=async fn=>{const log=console.log;console.log=()=>{};try{return await fn();}finally{console.log=log;}};
const idx=records=>records.map(r=>Number(r.id.split("|")[2]));
const range=(from,to)=>Array.from({length:to-from},(_,i)=>from+i);

test("audit cursor: seat deactivation, disconnect and reconnect end an old cursor before any WHOOP request",async()=>{
  const db=await fixture([[A,"developer"],[B,"public"]]);
  try{
    const w=fakeWhoop(),call=setup(w);
    const first=content(await call(db,B,"get_recovery",{auto_page:true}));
    assert.ok(first.next_token);
    // Seat (membership) revoked: 403 at the router, WHOOP never called.
    db.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(B);
    let n=w.calls.length;
    const denied=await call(db,B,"get_recovery",{auto_page:true,next_token:first.next_token});
    assert.equal(denied.status,403);assert.equal(w.calls.length,n);
    db.sqlite.prepare("UPDATE whoop_members SET active=1 WHERE user_id=?").run(B);
    // Seat role change does not alter isolation or the sequence.
    db.sqlite.prepare("UPDATE whoop_connections SET seat_role='public' WHERE user_id=?").run(A);
    assert.ok(content(await call(db,A,"get_sleep",{auto_page:true})).records.every(r=>r.account==="access-"+A));
    // An older cursor (sealed 10 s ago) for B's first WHOOP connection.
    const old=await sealCursor({env:baseEnv,userId:B,resource:"recovery",query:{start:null,end:null},
      whoopToken:btoa("recovery:100"),depth:4,now:()=>Date.now()-10_000});
    const disconnected=await call(db,B,"disconnect_whoop",{});
    assert.equal(content(disconnected).disconnected,true);
    n=w.calls.length;
    const gone=await call(db,B,"get_recovery",{auto_page:true,next_token:old});
    assert.equal(gone.body.result.isError,true);assert.equal(w.calls.length,n);
    // Reconnect a different WHOOP account.
    await connect(db.sqlite,B,"public","access2-"+B);
    for(const args of [{auto_page:true,next_token:old},{limit:25,next_token:old},{auto_page:true,next_token:first.next_token}]){
      const stale=await call(db,B,"get_recovery",args);
      assert.equal(stale.body.result.isError,true,JSON.stringify(args).slice(0,40));
      assert.match(stale.body.result.content[0].text,/not valid/);
      assert.equal(stale.body.result.structuredContent,undefined);
    }
    assert.equal(w.calls.length,n,"no WHOOP request for a pre-disconnect cursor");
    // revoked_at has millisecond precision: a sequence started right after the
    // reconnect (no delay) pages normally to the end (Codex P2 on f9ff3a4).
    assert.match(db.sqlite.prepare("SELECT revoked_at FROM whoop_credential_revocations WHERE user_id=?").get(B).revoked_at,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    const got=[];let cursor=null;
    do{const out=content(await call(db,B,"get_recovery",cursor?{auto_page:true,next_token:cursor}:{auto_page:true}));
      assert.ok(out.records.every(r=>r.account==="access2-"+B));got.push(...idx(out.records));cursor=out.next_token;}while(cursor);
    assert.deepEqual(got,range(0,TOTAL));
    // A's cursors are untouched by B's disconnect.
    const a=content(await call(db,A,"get_cycles",{auto_page:true}));
    assert.equal(content(await call(db,A,"get_cycles",{auto_page:true,next_token:a.next_token})).records.length,100);
  }finally{db.close();}
});

test("audit cursor: a disconnect and reconnect during a call never mixes accounts (Codex P2 on f9ff3a4)",async()=>{
  const db=await fixture([[A,"developer"],[B,"public"]]);
  try{
    // While WHOOP serves the request at offset `at`, B disconnects (same
    // statements as disconnect_whoop) and reconnects a different WHOOP account.
    let at=null,account=2;
    const swap=()=>{
      at=null;
      db.sqlite.prepare("INSERT INTO whoop_credential_revocations(user_id,revoked_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET revoked_at=excluded.revoked_at")
        .run(B,new Date().toISOString().slice(0,23).replace("T"," "));
      db.sqlite.prepare("DELETE FROM whoop_connections WHERE user_id=?").run(B);
      return connect(db.sqlite,B,"public",`access${account++}-${B}`);
    };
    // Await the swap: connect() seals tokens asynchronously, and a reconnect
    // still in progress when the next call starts made this test flaky under load.
    const w=fakeWhoop({fail:async({offset})=>{if(at!==null&&offset===at)await swap();return null;}});
    const call=setup(w);
    // auto_page with no cursor: the page in flight during the swap is dropped.
    at=25;
    let out=content(await call(db,B,"get_recovery",{auto_page:true}));
    assert.deepEqual(idx(out.records),range(0,25),"only pages read before the swap");
    assert.ok(out.records.every(r=>r.account==="access-"+B));
    assert.equal(out.complete,false);assert.equal(out.incomplete_reason,"connection_changed");
    assert.equal(out.next_token,null);
    await new Promise(r=>setTimeout(r,5));
    // The new connection starts its own sequence immediately and continues it.
    const fresh=content(await call(db,B,"get_recovery",{auto_page:true}));
    assert.ok(fresh.records.every(r=>r.account==="access2-"+B));
    const next=content(await call(db,B,"get_recovery",{auto_page:true,next_token:fresh.next_token}));
    assert.deepEqual(idx(next.records),range(100,200));
    assert.ok(next.records.every(r=>r.account==="access2-"+B));
    // Swap during the first page of an auto_page continuation: an error, no data.
    await new Promise(r=>setTimeout(r,5));
    const page=content(await call(db,B,"get_recovery",{limit:25}));
    at=25;
    const first=await call(db,B,"get_recovery",{auto_page:true,next_token:page.next_token});
    assert.equal(first.body.result.isError,true);assert.equal(content(first),undefined);
    // Manual paging, with and without a cursor: same.
    await new Promise(r=>setTimeout(r,5));
    const p2=content(await call(db,B,"get_recovery",{limit:25}));
    at=25;
    const manual=await call(db,B,"get_recovery",{limit:25,next_token:p2.next_token});
    assert.equal(manual.body.result.isError,true);assert.equal(content(manual),undefined);
    await new Promise(r=>setTimeout(r,5));
    at=0;
    const manualFirst=await call(db,B,"get_recovery",{limit:25});
    assert.equal(manualFirst.body.result.isError,true);assert.equal(content(manualFirst),undefined);
    // A's sequence is never affected.
    assert.deepEqual(idx(content(await call(db,A,"get_recovery",{auto_page:true})).records),range(0,100));
  }finally{db.close();}
});

test("audit cursor: second-precision disconnect markers stay conservative",async()=>{
  const db=await fixture([[B,"public"]]);
  try{
    const w=fakeWhoop(),call=setup(w);
    const now=Date.now(),stamp=new Date(now).toISOString().slice(0,19).replace("T"," ");
    db.sqlite.prepare("INSERT INTO whoop_credential_revocations(user_id,revoked_at) VALUES(?,?)").run(B,stamp);
    const secondStart=Date.parse(stamp.replace(" ","T")+"Z");
    const inSecond=await sealCursor({env:baseEnv,userId:B,resource:"sleep",query:{start:null,end:null},whoopToken:btoa("sleep:25"),depth:1,now:()=>secondStart+999});
    const after=await sealCursor({env:baseEnv,userId:B,resource:"sleep",query:{start:null,end:null},whoopToken:btoa("sleep:25"),depth:1,now:()=>secondStart+1000});
    assert.equal((await call(db,B,"get_sleep",{limit:25,next_token:inSecond})).body.result.isError,true);
    assert.deepEqual(idx(content(await call(db,B,"get_sleep",{limit:25,next_token:after})).records),range(25,50));
    db.sqlite.prepare("UPDATE whoop_credential_revocations SET revoked_at='not a date' WHERE user_id=?").run(B);
    assert.equal((await call(db,B,"get_sleep",{limit:25,next_token:after})).body.result.isError,true);
  }finally{db.close();}
});

test("audit concurrency: 8 members x 4 endpoints page at once with jitter; no leakage, no cursor reuse, bounded requests",async()=>{
  const users=Array.from({length:8},(_,i)=>[member(i+1),i===0?"developer":"public"]);
  const db=await fixture(users);
  try{
    const w=fakeWhoop({delay:4}),call=setup(w);
    const cursors=new Set();
    await Promise.all(users.flatMap(([id])=>Object.keys(ENDPOINTS).map(async name=>{
      const got=[];let cursor=null,i=0;
      do{
        const out=content(await call(db,id,name,cursor?{auto_page:i%2===0,next_token:cursor,limit:25}:{auto_page:true}));
        assert.ok(out.records.every(r=>r.account==="access-"+id),"leak");
        got.push(...idx(out.records));cursor=out.next_token;i++;
        if(cursor){assert.ok(!cursors.has(cursor),"cursor collision");cursors.add(cursor);}
      }while(cursor&&i<50);
      assert.deepEqual(got,range(0,TOTAL),id+" "+name);
    })));
    // Every WHOOP page was requested with the bearer of its own member and <=25 records.
    assert.ok(w.calls.every(c=>c.limit<=25&&/^access-/.test(c.bearer)));
    // 8 members x 4 endpoints x (100+25+100+5 records -> 4+1+4+1 pages).
    assert.equal(w.calls.length,8*4*10);
  }finally{db.close();}
});

test("audit 429: rate limits are reported as such with Retry-After / X-RateLimit-Reset, never retried in a loop",async()=>{
  const db=await fixture([[A,"developer"]]);
  try{
    const limited=headers=>new Response("SECRET throttle body",{status:429,headers});
    let w=fakeWhoop({fail:()=>limited({"retry-after":"30"})});
    let r=await setup(w)(db,A,"get_recovery",{auto_page:true});
    assert.equal(r.body.result.isError,true);
    assert.match(r.body.result.content[0].text,/rate limiting.*about 30 seconds/);
    assert.doesNotMatch(JSON.stringify(r.body),/SECRET/);
    assert.equal(w.calls.length,1,"one request, no retry loop");
    w=fakeWhoop({fail:()=>limited({"x-ratelimit-reset":"12"})});
    r=await setup(w)(db,A,"get_sleep",{limit:10});
    assert.match(r.body.result.content[0].text,/about 12 seconds/);
    w=fakeWhoop({fail:()=>limited({})});
    r=await setup(w)(db,A,"get_cycles",{limit:10});
    assert.match(r.body.result.content[0].text,/rate limiting.*Wait a minute/);
    // Mid-sequence: records read so far, rate_limited, retry hint, resumable cursor.
    let once=true;
    w=fakeWhoop({fail:({offset})=>offset===50&&once?(once=false,limited({"retry-after":"7"})):null});
    const call=setup(w);
    const part=content(await call(db,A,"get_workouts",{auto_page:true}));
    assert.deepEqual(idx(part.records),range(0,50));
    assert.equal(part.incomplete_reason,"rate_limited");assert.equal(part.retry_after_seconds,7);
    assert.equal(part.complete,false);
    const got=[...idx(part.records)];let cursor=part.next_token;
    while(cursor){const out=content(await call(db,A,"get_workouts",{auto_page:true,next_token:cursor}));got.push(...idx(out.records));cursor=out.next_token;}
    assert.deepEqual(got,range(0,TOTAL));
    // Non-429 failures are not reported as rate limiting (5xx: temporarily unavailable).
    w=fakeWhoop({fail:()=>new Response("{}",{status:503})});
    r=await setup(w)(db,A,"get_recovery",{limit:5});
    assert.equal(r.body.result.content[0].text,"WHOOP is temporarily unavailable (reading recovery data). Retry shortly. No WHOOP data was returned and nothing was changed.");
    // REST history route: 429 with a Retry-After header.
    w=fakeWhoop({fail:()=>limited({"retry-after":"9"})});
    const route=createStagingRouter({verifyIdentity:async()=>A,
      whoopRequest:(d,u,res,e,o)=>callWhoop(d,u,res,e,o,{fetcher:w.fetch})});
    const rest=await route(new Request("https://staging.invalid/v1/whoop/recovery?limit=5",{headers:{authorization:"Bearer synthetic"}}),{...baseEnv,DB:db});
    assert.equal(rest.status,429);assert.equal(rest.headers.get("retry-after"),"9");
    assert.doesNotMatch(await rest.text(),/SECRET/);
  }finally{db.close();}
});

test("audit 429: a rate-limited token refresh is reported as rate limited and keeps stored tokens",async()=>{
  const db=await fixture([[A,"developer"]]);
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET expires_at=? WHERE user_id=?").run(new Date(Date.now()-1000).toISOString(),A);
    const before=db.sqlite.prepare("SELECT * FROM whoop_connections").all();
    const calls=[];
    const fetcher=async url=>{calls.push(String(url));return new Response("{}",{status:429,headers:{"retry-after":"20"}});};
    const route=createStagingRouter({verifyIdentity:async()=>A,
      whoopRequest:(d,u,res,e,o)=>callWhoop(d,u,res,e,o,{fetcher,sleep:async()=>{}})});
    const message={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_recovery",arguments:{limit:5}}};
    const res=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{"content-type":"application/json",
      accept:"application/json, text/event-stream",authorization:"Bearer synthetic"},body:JSON.stringify(message)}),{...baseEnv,DB:db});
    const body=await res.json();
    assert.match(body.result.content[0].text,/rate limiting.*about 20 seconds/);
    assert.deepEqual(calls,["https://api.prod.whoop.com/oauth/oauth2/token"]);
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM whoop_connections").all(),before);
  }finally{db.close();}
});

test("audit 429: retryAfterSeconds parses seconds and HTTP dates and bounds junk",()=>{
  const h=o=>new Headers(o),now=Date.parse("2026-10-18T20:00:00Z");
  assert.equal(retryAfterSeconds(h({"retry-after":"5"}),now),5);
  assert.equal(retryAfterSeconds(h({"retry-after":"Sun, 18 Oct 2026 20:00:45 GMT"}),now),45);
  assert.equal(retryAfterSeconds(h({"retry-after":"Sun, 18 Oct 2026 19:00:00 GMT"}),now),0);
  assert.equal(retryAfterSeconds(h({"retry-after":"999999"}),now),3600);
  assert.equal(retryAfterSeconds(h({"retry-after":"soon","x-ratelimit-reset":"3"}),now),3);
  assert.equal(retryAfterSeconds(h({"x-ratelimit-reset":"-1"}),now),null);
  assert.equal(retryAfterSeconds(h({}),now),null);
  assert.equal(retryAfterSeconds(null,now),null);
});

test("audit partial failures: random interruptions on every endpoint never skip or duplicate a record",async()=>{
  const db=await fixture([[A,"developer"],[B,"public"]]);
  try{
    let seed=1234567;const rand=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
    const statuses=[429,500,502,503];
    const w=fakeWhoop({fail:()=>rand()<0.3?new Response("{}",{status:statuses[Math.floor(rand()*4)]}):null});
    const call=setup(w);
    for(const who of [A,B])for(const name of Object.keys(ENDPOINTS)){
      const got=[];let cursor=null,done=false,attempts=0;
      while(!done&&attempts<200){
        attempts++;
        const args=cursor?{next_token:cursor,...(attempts%3?{auto_page:true}:{limit:25})}:(attempts%3?{auto_page:true}:{limit:25});
        const r=await call(db,who,name,args);
        if(r.body.result.isError)continue; // nothing read: retry the same cursor
        const out=content(r);
        got.push(...idx(out.records));
        assert.equal(out.complete,out.next_token===null&&!out.incomplete_reason);
        if(out.complete){done=true;break;}
        assert.ok(out.next_token,"an interrupted call must hand back a resumable cursor");
        cursor=out.next_token;
      }
      assert.ok(done,who+name);
      assert.deepEqual(got,range(0,TOTAL),who+" "+name);
    }
  }finally{db.close();}
});

test("audit cursors: internal WHOOP walks (summary baseline, stress window) accept base64-padded cursors",async()=>{
  // WHOOP cursors may carry '=' padding; callWhoop accepts them since PR #63.
  const rows=Array.from({length:60},(_,i)=>({cycle_id:i,created_at:new Date(Date.parse("2026-10-17T08:00:00Z")-i*86400000).toISOString()}));
  const calls=[];
  const whoopRequest=async(db,userId,resource,env,opts)=>{
    calls.push(opts.next_token??null);
    const off=opts.next_token?Number(atob(opts.next_token)):0;
    const next=off+25<rows.length?btoa(String(off+25)):null; // "MjU=" style padding
    if(next)assert.match(next,/=$/);
    return {records:rows.slice(off,off+25),next_token:next};
  };
  const ctx={db:null,userId:A,env:{}};
  const walked=await collectHistoryPages(whoopRequest,ctx,"recovery",{maxPages:6});
  assert.equal(walked.complete,true);assert.equal(walked.records.length,60);
  const windowed=await fetchStressWindow({...ctx,whoopRequest},"recovery","2026-08-01","2026-10-17");
  assert.equal(windowed.complete,true);assert.equal(windowed.records.length,60);
  // A repeated or unsafe cursor still ends the walk as incomplete.
  const loop=await collectHistoryPages(async()=>({records:[rows[0]],next_token:"../x="}),ctx,"recovery",{maxPages:6});
  assert.equal(loop.complete,false);
});

function hcFixture(){
  const s=new DatabaseSync(":memory:");
  for(const n of ["0001_initial.sql","0004_medical_context_review.sql","0006_health_import_consent.sql","0022_health_import_fences.sql","0007_health_connect_ingest.sql"])
    s.exec(readFileSync(new URL("../migrations/"+n,import.meta.url),"utf8"));
  for(const id of [A,B]){
    s.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    s.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
  }
  return {sqlite:s,...d1Database(s),close(){s.close();}};
}
test("audit webhook: written/unchanged report what the upsert changed; stored keeps its meaning",async()=>{
  const db=hcFixture();
  try{
    const issue=async id=>{const r=await handleMcpRpc({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"issue_health_connect_ingest_token",arguments:{consent:ISSUE_CONSENT}}},
      {db,userId:id,env:{HEALTH_CONNECT_WEBHOOK_ENABLED:"true"}},{modern:false});return JSON.parse(r.result.content[0].text).header_value.slice(7);};
    const ta=await issue(A),tb=await issue(B);
    const post=async(t,steps)=>(await healthConnectWebhook(new Request("https://whooplens.tech/api/health-connect/webhook",{method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer "+t},body:JSON.stringify({timestamp:"2026-10-13T03:00:00Z",app_version:"1",steps})}),
      {DB:db,HEALTH_CONNECT_WEBHOOK_ENABLED:"true"})).json();
    const step=(count,modified,id="s1")=>({count,start_time:"2026-10-12T00:00:00Z",end_time:"2026-10-13T00:00:00Z",metadata:{id,...(modified?{lastModifiedTime:modified}:{})}});
    const counts=r=>[r.stored,r.written,r.unchanged];
    assert.deepEqual(counts(await post(ta,[step(100,"2026-10-13T02:00:00Z"),step(7,"2026-10-13T02:00:00Z","s2")])),[2,2,0]);
    assert.deepEqual(counts(await post(ta,[step(100,"2026-10-13T02:00:00Z")])),[1,1,0]); // same-version retry rewrites
    assert.deepEqual(counts(await post(ta,[step(5,"2026-10-01T00:00:00Z")])),[1,0,1]); // older version
    assert.deepEqual(counts(await post(ta,[step(6,null)])),[1,0,1]); // unversioned over versioned
    assert.deepEqual(counts(await post(ta,[step(5,"2026-10-01T00:00:00Z"),step(9,"2026-10-14T00:00:00Z","s2")])),[2,1,1]);
    // Same Health Connect id for another member is a separate row.
    assert.deepEqual(counts(await post(tb,[step(3,"2026-10-01T00:00:00Z")])),[1,1,0]);
    const rows=db.sqlite.prepare("SELECT user_id,record_key,payload_json FROM health_connect_records ORDER BY user_id,record_key").all()
      .map(r=>[r.user_id,r.record_key,JSON.parse(r.payload_json).count]);
    assert.deepEqual(rows,[[A,"hc:s1",100],[A,"hc:s2",9],[B,"hc:s1",3]]);
  }finally{db.close();}
});

test("audit AI: fallback reasons and quota on model errors, timeouts, filtered output and a missing binding",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const f of ["0009_ai_usage.sql","0010_ai_account_snapshot.sql","0012_ai_usage_event.sql"])
    sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  const db={sqlite,...d1Database(sqlite)};
  const used=()=>Object.fromEntries(sqlite.prepare("SELECT scope,used FROM ai_usage").all().map(r=>[r.scope,r.used]));
  const data={records:[{created_at:"2026-10-15T08:00:00Z",score_state:"SCORED",score:{recovery_score:55}},
    {created_at:"2026-10-16T08:00:00Z",score_state:"SCORED",score:{recovery_score:61}}],next_token:null};
  const env=ai=>({AI_SUMMARY_ENABLED:"true",AI_SUMMARY_TIMEOUT_MS:"50",AI:ai,AI_ANALYTICS_ACCOUNT_ID:"a".repeat(32),
    AI_ACCOUNT_ANALYTICS_TOKEN:"synthetic-analytics-token-xxxxxxxx",AI_ANALYTICS_QUERY:async()=>({neurons:0})});
  const run=async(id,ai)=>quietly(()=>attachSummary(data,{db,userId:id,env:env(ai),tool:"get_recovery",now:Date.parse("2026-10-18T12:00:00Z")}));
  const scope=id=>"user:"+id;
  // Thrown model error: template, model_error, reservation kept (usage unknown).
  let out=await run(member(11),{run:async()=>{throw Error("upstream 500");}});
  assert.equal(out.summary.status,"template");assert.equal(out.summary.fallback_reason,"model_error");
  assert.deepEqual(out.records,data.records);
  const reserved=used()[scope(member(11))];assert.ok(reserved>0);
  // Hung model: timeout after AI_SUMMARY_TIMEOUT_MS, reservation kept.
  const t0=Date.now();
  out=await run(member(12),{run:()=>new Promise(()=>{})});
  assert.equal(out.summary.fallback_reason,"timeout");assert.ok(Date.now()-t0<2000);
  assert.equal(used()[scope(member(12))],reserved);
  // Output the selector rejects: filter, and usage reconciled to the reported tokens.
  out=await run(member(13),{run:async()=>({response:"You should rest.",usage:{prompt_tokens:400,completion_tokens:8}})});
  assert.equal(out.summary.fallback_reason,"filter");
  assert.ok(used()[scope(member(13))]<reserved);
  // No AI binding: model_error and nothing reserved.
  out=await run(member(14),undefined);
  assert.equal(out.summary.fallback_reason,"model_error");
  assert.equal(used()[scope(member(14))],undefined);
  // Valid selection: model status, no fallback reason.
  out=await run(member(15),{run:async()=>({response:'{"selected":[0]}',usage:{prompt_tokens:400,completion_tokens:8}})});
  assert.equal(out.summary.status,"model");assert.equal(out.summary.fallback_reason,undefined);
  // Exhausted member quota: quota fallback, model never called.
  sqlite.prepare("INSERT OR REPLACE INTO ai_usage(scope,day,used,cap) VALUES(?,?,2500,2500)").run(scope(member(16)),"2026-10-18");
  let called=false;
  out=await run(member(16),{run:async()=>{called=true;return {response:'{"selected":[0]}'};}});
  assert.equal(out.summary.fallback_reason,"quota");assert.equal(called,false);
  // Global counter equals the sum of member counters (no double counting).
  const all=used();
  const members=Object.entries(all).filter(([k])=>k!=="global").reduce((s,[,v])=>s+v,0);
  assert.equal(all.global,members-2500);
  sqlite.close();
});
