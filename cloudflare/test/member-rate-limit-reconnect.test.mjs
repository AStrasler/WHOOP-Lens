// Per-member WHOOP request budget (migration 0015) and connection generations
// for reconnect cursor invalidation (migration 0016). Synthetic members and a
// fake WHOOP only; no real member data.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {fixture,fakeWhoop,content,member,TOTAL,baseEnv,key,connect} from "./audit-fixtures.mjs";
import {d1Database} from "./d1-sqlite.mjs";
import {callWhoop} from "../src/whoop-api.mjs";
import {createStagingRouter} from "../src/router.mjs";
import {sealCursor} from "../src/history-pagination.mjs";
import {createWhoopAuthorization,acceptWhoopCallback} from "../src/whoop-oauth.mjs";
import {memberLimits,reserveWhoopRequest,DEFAULT_MEMBER_LIMITS,MemberRateLimited} from "../src/member-rate-limit.mjs";

const A=member(11),B=member(12),DEV=member(13);
const migration=name=>readFileSync(new URL("../migrations/"+name,import.meta.url),"utf8");
const rollback=name=>readFileSync(new URL("../migration/rollback/"+name,import.meta.url),"utf8");
const BUDGET="0015_member_whoop_request_budget.sql",GENERATIONS="0016_whoop_connection_generations.sql";
const quietly=async fn=>{const log=console.log;console.log=()=>{};try{return await fn();}finally{console.log=log;}};
const idx=records=>records.map(r=>Number(r.id.split("|")[2]));
const range=(from,to)=>Array.from({length:to-from},(_,i)=>from+i);
// Fixed UTC instant 10 s into a minute, so window arithmetic is exact.
const T0=Date.parse("2026-10-18T19:00:10Z");

async function db(users=[[A,"public"],[B,"public"],[DEV,"developer"]],{budget=true,generations=true}={}){
  const d=await fixture(users);
  if(budget)d.sqlite.exec(migration(BUDGET));
  if(generations)applyGenerations(d);
  return d;
}
// 0016 seeds every existing member with a large generation (apply time in ms).
// Tests count generations relative to that seed.
const seeds=new WeakMap();
function applyGenerations(d){
  d.sqlite.exec(migration(GENERATIONS));
  seeds.set(d,new Map(d.sqlite.prepare("SELECT user_id,generation FROM whoop_connection_generations").all().map(r=>[r.user_id,r.generation])));
}
// MCP caller with a controllable clock for the budget windows.
function harness(whoop,clock={t:T0},extraEnv={}){
  const route=createStagingRouter({
    verifyIdentity:async request=>request.headers.get("x-synthetic-member"),
    whoopRequest:(d,userId,resource,env,opts)=>callWhoop(d,userId,resource,env,opts,{fetcher:whoop.fetch,now:()=>clock.t})
  });
  const env=d=>({...baseEnv,WHOOP_LENS_DEVELOPER_USER_ID:DEV,...extraEnv,DB:d});
  const call=async(d,who,name,args)=>{
    const message={jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}};
    const response=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{
      "content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic",
      "x-synthetic-member":who,"mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name
    },body:JSON.stringify(message)}),env(d));
    return {status:response.status,body:await response.json()};
  };
  const rest=async(d,who,path)=>route(new Request("https://staging.invalid"+path,{headers:{
    authorization:"Bearer synthetic","x-synthetic-member":who}}),env(d));
  return {call,rest,clock};
}
const budgetRow=(d,id)=>({...d.sqlite.prepare("SELECT minute_count,day_count FROM whoop_member_request_budget WHERE user_id=?").get(id)});
const rawGeneration=(d,id)=>d.sqlite.prepare("SELECT generation FROM whoop_connection_generations WHERE user_id=?").get(id)?.generation??0;
const generation=(d,id)=>rawGeneration(d,id)-(seeds.get(d)?.get(id)??0);

// ---------------------------------------------------------------- migrations

test("migrations 0015/0016: apply in order after 0001-0014, roll back, re-apply; existing rows untouched",async()=>{
  const files=readdirSync(new URL("../migrations/",import.meta.url)).filter(f=>f.endsWith(".sql")).sort();
  assert.deepEqual(files.slice(-2),[BUDGET,GENERATIONS],"next migration numbers");
  const sqlite=new DatabaseSync(":memory:");
  try{
    // wrangler's own bookkeeping table, so the rollback's DELETE is exercised.
    sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    const apply=f=>{sqlite.exec(migration(f));sqlite.prepare("INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)").run(f);};
    for(const f of files.slice(0,-2))apply(f);
    // Pre-existing member, connection and health row before the new migrations.
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(A,A);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(A);
    sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)").run(A,"2099-01-01T00:00:00Z","a","r","v1","public");
    sqlite.prepare("INSERT INTO whoop_recovery(user_id,whoop_id,date,raw_json) VALUES(?,?,?,?)").run(A,"w1","2026-10-01","{}");
    const snapshot=()=>JSON.stringify(["identity_links","whoop_members","whoop_connections","whoop_recovery"].map(t=>sqlite.prepare("SELECT * FROM "+t).all()));
    const before=snapshot();
    const applied=Date.now();
    apply(BUDGET);apply(GENERATIONS);
    assert.equal(snapshot(),before,"existing rows unchanged");
    // Existing members have no counters (full budget). Each gets a generation
    // seeded at the apply time in ms, above anything a cursor could carry.
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whoop_member_request_budget").get().n,0);
    const gen=()=>sqlite.prepare("SELECT generation g FROM whoop_connection_generations WHERE user_id=?").get(A)?.g;
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whoop_connection_generations").get().n,1);
    const seeded=gen();
    assert.ok(seeded>=Math.floor(applied/1000)*1000&&seeded<=Date.now(),"seeded at apply time");
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(whoop_member_request_budget)").all().map(c=>c.name),
      ["user_id","minute_start","minute_count","day_start","day_count","updated_at"]);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(whoop_connection_generations)").all().map(c=>c.name),
      ["user_id","generation","updated_at"]);
    // No health data, tokens or identifiers beyond the member id.
    for(const f of [BUDGET,GENERATIONS])assert.doesNotMatch(migration(f).replace(/^--.*$/gm,""),/token|raw_json|score|hrv|email/i);
    // Re-running keeps the tables (IF NOT EXISTS) and only bumps generations.
    sqlite.exec(migration(BUDGET));sqlite.exec(migration(GENERATIONS));
    assert.ok(gen()>seeded);
    // A member who reconnected many times keeps increasing, never resets.
    sqlite.prepare("UPDATE whoop_connection_generations SET generation=generation+500 WHERE user_id=?").run(A);
    const high=gen();
    // Down, in reverse order, then up again.
    sqlite.exec(rollback("0016_whoop_connection_generations.down.sql"));
    sqlite.exec(rollback("0015_member_whoop_request_budget.down.sql"));
    const tables=()=>sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    assert.ok(!tables().includes("whoop_member_request_budget")&&!tables().includes("whoop_connection_generations"));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM d1_migrations WHERE name IN (?,?)").get(BUDGET,GENERATIONS).n,0);
    assert.equal(snapshot(),before,"rollback leaves existing rows unchanged");
    await new Promise(r=>setTimeout(r,1100));
    apply(BUDGET);apply(GENERATIONS);
    assert.ok(tables().includes("whoop_member_request_budget")&&tables().includes("whoop_connection_generations"));
    // Re-applied after a rollback: the new seed exceeds the dropped history.
    assert.ok(gen()>high,"no generation from before the drop can match again");
  }finally{sqlite.close();}
});

// ---------------------------------------------------------------- limits

test("limits: defaults are a fair share; env overrides are clamped and a bad value never locks anyone out",()=>{
  assert.deepEqual(DEFAULT_MEMBER_LIMITS,{perMinute:25,perDay:1000});
  const both=(pm,pd)=>({public:{perMinute:pm,perDay:pd},developer:{perMinute:pm,perDay:pd}});
  assert.deepEqual(memberLimits({}),both(25,1000));
  // Developer seat: same limit by default, configurable separately.
  assert.deepEqual(memberLimits({WHOOP_DEVELOPER_LIMIT_PER_MINUTE:"60",WHOOP_DEVELOPER_LIMIT_PER_DAY:"3000"}),
    {public:{perMinute:25,perDay:1000},developer:{perMinute:60,perDay:3000}});
  for(const bad of ["0","-1","abc","1e3"," ","","2.5",null,undefined])
    assert.deepEqual(memberLimits({WHOOP_MEMBER_LIMIT_PER_MINUTE:bad,WHOOP_MEMBER_LIMIT_PER_DAY:bad,
      WHOOP_DEVELOPER_LIMIT_PER_MINUTE:bad,WHOOP_DEVELOPER_LIMIT_PER_DAY:bad}),both(25,1000),String(bad));
  assert.deepEqual(memberLimits({WHOOP_MEMBER_LIMIT_PER_MINUTE:"500",WHOOP_MEMBER_LIMIT_PER_DAY:"99999"}),both(100,10000));
});

test("limits: over the per-minute budget no WHOOP request is made; MCP and REST report the limit and Retry-After",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),h=harness(w,{t:T0},{WHOOP_MEMBER_LIMIT_PER_MINUTE:"5"});
    for(let i=0;i<5;i++)assert.equal(content(await h.call(d,A,"get_sleep",{limit:5})).records.length,5);
    assert.deepEqual(budgetRow(d,A),{minute_count:5,day_count:5});
    const sent=w.calls.length;
    const limited=await quietly(()=>h.call(d,A,"get_sleep",{limit:5}));
    assert.equal(limited.body.result.isError,true);
    assert.match(limited.body.result.content[0].text,/request limit \(5 WHOOP requests per minute\).*No WHOOP request was made.*Wait about 50 seconds/s);
    const response=await quietly(()=>h.rest(d,A,"/v1/whoop/recovery?limit=5"));
    assert.equal(response.status,429);
    assert.equal(response.headers.get("retry-after"),"50");
    const body=await response.json();
    assert.equal(body.rate_limit_scope,"member");
    assert.doesNotMatch(JSON.stringify(body),/access-|synthetic/);
    assert.equal(w.calls.length,sent,"nothing sent to WHOOP while over budget");
    // A rejected attempt does not consume budget.
    assert.deepEqual(budgetRow(d,A),{minute_count:5,day_count:5});
  }finally{d.close();}
});

test("limits: the minute window resets; the day window holds until the next UTC day",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),clock={t:T0},h=harness(w,clock,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"3",WHOOP_MEMBER_LIMIT_PER_DAY:"5"});
    const ok=async()=>assert.ok(content(await h.call(d,A,"get_cycles",{limit:1})).records);
    const limited=async()=>{const r=await quietly(()=>h.call(d,A,"get_cycles",{limit:1}));assert.equal(r.body.result.isError,true);return r.body.result.content[0].text;};
    for(let i=0;i<3;i++)await ok();
    assert.match(await limited(),/per minute\).*about 50 seconds/s);
    clock.t+=59_999-10_000+1; // first millisecond of the next minute
    await ok();await ok();
    assert.deepEqual(budgetRow(d,A),{minute_count:2,day_count:5});
    clock.t+=60_000;
    // Minute has room but the day is spent: retry at the next UTC midnight.
    const text=await limited();
    const toMidnight=Math.ceil((Date.parse("2026-10-19T00:00:00Z")-clock.t)/1000);
    assert.match(text,new RegExp(`per day \\(UTC\\)\\).*about ${toMidnight} seconds`,"s"));
    clock.t=Date.parse("2026-10-19T00:00:01Z");
    await ok();
    assert.deepEqual(budgetRow(d,A),{minute_count:1,day_count:1});
    // A Worker whose clock is behind counts in the stored (newer) window.
    clock.t-=120_000;
    await ok();
    assert.deepEqual(budgetRow(d,A),{minute_count:2,day_count:2});
  }finally{d.close();}
});

test("limits: auto_page stops at the budget with partial records and a cursor that resumes without gaps",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),clock={t:T0},h=harness(w,clock,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"6"});
    const first=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(first.records.length,100);assert.equal(first.complete,false);
    const second=content(await quietly(()=>h.call(d,A,"get_recovery",{auto_page:true,next_token:first.next_token})));
    assert.equal(second.records.length,50);
    assert.equal(second.complete,false);
    assert.equal(second.incomplete_reason,"rate_limited");
    assert.equal(second.rate_limit_scope,"member");
    assert.equal(second.retry_after_seconds,50);
    assert.match(second.next_token,/^wlc1\./);
    // Same minute: still limited, nothing returned, the cursor stays usable.
    const blocked=await quietly(()=>h.call(d,A,"get_recovery",{auto_page:true,next_token:second.next_token}));
    assert.equal(blocked.body.result.isError,true);
    clock.t+=60_000;
    const got=[...idx(first.records),...idx(second.records)];let cursor=second.next_token;
    while(cursor){const out=content(await h.call(d,A,"get_recovery",{auto_page:true,next_token:cursor}));got.push(...idx(out.records));cursor=out.next_token;}
    assert.deepEqual(got,range(0,TOTAL),"no skipped or duplicated records");
  }finally{d.close();}
});

test("limits: members are isolated; the developer seat keeps its own (configurable) limit",async()=>{
  const d=await db();
  try{
    // The developer seat is identified by seat_role, even without WHOOP_LENS_DEVELOPER_USER_ID.
    const w=fakeWhoop(),h=harness(w,{t:T0},{WHOOP_MEMBER_LIMIT_PER_MINUTE:"2",WHOOP_DEVELOPER_LIMIT_PER_MINUTE:"4",WHOOP_LENS_DEVELOPER_USER_ID:undefined});
    for(let i=0;i<2;i++)await h.call(d,A,"get_workouts",{limit:1});
    assert.equal((await quietly(()=>h.call(d,A,"get_workouts",{limit:1}))).body.result.isError,true);
    // B is unaffected by A's exhausted budget, and the reverse.
    for(let i=0;i<2;i++)assert.ok(content(await h.call(d,B,"get_workouts",{limit:1})).records.every(r=>r.account==="access-"+B));
    assert.equal((await quietly(()=>h.call(d,B,"get_workouts",{limit:1}))).body.result.isError,true);
    for(let i=0;i<4;i++)assert.ok(content(await h.call(d,DEV,"get_workouts",{limit:1})).records);
    assert.equal((await quietly(()=>h.call(d,DEV,"get_workouts",{limit:1}))).body.result.isError,true);
    assert.deepEqual([A,B,DEV].map(id=>budgetRow(d,id).minute_count),[2,2,4]);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_member_request_budget").get().n,3,"one row per member");
    // Without an override the developer seat has the member limit (not exempt).
    const plain=harness(fakeWhoop(),{t:T0+120_000},{WHOOP_MEMBER_LIMIT_PER_MINUTE:"2"});
    for(let i=0;i<2;i++)assert.ok(content(await plain.call(d,DEV,"get_workouts",{limit:1})).records);
    assert.equal((await quietly(()=>plain.call(d,DEV,"get_workouts",{limit:1}))).body.result.isError,true);
  }finally{d.close();}
});

test("limits: parallel requests from one member never exceed the budget; other members are not starved",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop({delay:5}),h=harness(w,{t:T0},{WHOOP_MEMBER_LIMIT_PER_MINUTE:"7"});
    const runs=await quietly(()=>Promise.all([
      ...Array.from({length:30},(_,i)=>h.call(d,A,["get_recovery","get_sleep","get_workouts","get_cycles"][i%4],{limit:2})),
      ...Array.from({length:5},()=>h.call(d,B,"get_sleep",{limit:2}))
    ]));
    const okA=runs.slice(0,30).filter(r=>!r.body.result.isError).length;
    assert.equal(okA,7);
    assert.equal(w.calls.filter(c=>c.bearer==="access-"+A).length,7);
    assert.ok(runs.slice(30).every(r=>!r.body.result.isError&&content(r).records.every(x=>x.account==="access-"+B)));
    assert.deepEqual(budgetRow(d,A),{minute_count:7,day_count:7});
  }finally{d.close();}
});

test("limits: switched off, or before migration 0015, nobody is limited; other D1 errors fail closed",async()=>{
  // Off: no counter writes at all.
  let d=await db();
  try{
    const w=fakeWhoop(),h=harness(w,{t:T0},{WHOOP_MEMBER_LIMIT_ENABLED:"false",WHOOP_MEMBER_LIMIT_PER_MINUTE:"1"});
    for(let i=0;i<3;i++)assert.ok(content(await h.call(d,A,"get_sleep",{limit:1})).records);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_member_request_budget").get().n,0);
  }finally{d.close();}
  // Table missing (code deployed before the migration, or after its rollback).
  d=await db(undefined,{budget:false});
  try{
    const w=fakeWhoop(),h=harness(w,{t:T0},{WHOOP_MEMBER_LIMIT_PER_MINUTE:"1"});
    for(let i=0;i<3;i++)assert.ok(content(await quietly(()=>h.call(d,A,"get_sleep",{limit:1}))).records);
    assert.equal(w.calls.length,3);
  }finally{d.close();}
  // Any other D1 failure: no WHOOP request is made.
  const broken={prepare(){return {bind(){return this;},async first(){throw Error("D1_ERROR: database is locked");}};}};
  await assert.rejects(reserveWhoopRequest(broken,A,{}),/database is locked/);
  await assert.rejects(reserveWhoopRequest(broken,"not-a-uuid",{}),/Invalid user/);
  // A limited reservation is a typed 429.
  d=await db();
  try{
    await reserveWhoopRequest(d,A,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"1"},{now:()=>T0});
    await quietly(()=>assert.rejects(reserveWhoopRequest(d,A,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"1"},{now:()=>T0}),
      e=>e instanceof MemberRateLimited&&e.status===429&&e.retryAfter===50&&e.window==="minute"&&e.limit===1));
  }finally{d.close();}
});

// ---------------------------------------------------------------- reconnect

const oauthEnv={...baseEnv,WHOOP_REDIRECT_URI:"https://whooplens.tech/api/whoop/callback"};
async function reconnect(d,id,accessToken){
  const start=await createWhoopAuthorization(d,id,oauthEnv);
  const auth=new URL(start.authorization_url);
  const url=new URL("https://whooplens.tech/api/whoop/callback");
  url.searchParams.set("state",auth.searchParams.get("state"));url.searchParams.set("code","synthetic-code-123");
  const tokenEndpoint=async()=>new Response(JSON.stringify({access_token:accessToken,refresh_token:"refresh2-"+id,expires_in:3600,scope:"offline"}),
    {status:200,headers:{"content-type":"application/json"}});
  return acceptWhoopCallback(d,url,oauthEnv,{fetcher:tokenEndpoint});
}

test("reconnect without disconnect: the OAuth overwrite bumps the generation and ends older cursors before any WHOOP request",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),h=harness(w);
    const firstA=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    const manualA=content(await h.call(d,A,"get_sleep",{limit:25}));
    const firstB=content(await h.call(d,B,"get_recovery",{auto_page:true}));
    assert.equal(generation(d,A),0);
    // A cursor sealed without a generation (by 04e4499d, or before 0016 existed)
    // is rejected once 0016 is present, even with no reconnect recorded.
    const legacy=await sealCursor({env:baseEnv,userId:A,resource:"cycles",query:{start:null,end:null},whoopToken:btoa("cycles:25"),depth:1});
    const before=w.calls.length;
    assert.match((await h.call(d,A,"get_cycles",{limit:25,next_token:legacy})).body.result.content[0].text,/not valid/);
    assert.equal(w.calls.length,before);
    // Same member authorizes WHOOP again with a different account, no disconnect.
    assert.deepEqual(await reconnect(d,A,"access2-"+A),{connected:true,seat_role:"public"});
    assert.equal(generation(d,A),1);
    const n=w.calls.length;
    for(const [name,args] of [["get_recovery",{auto_page:true,next_token:firstA.next_token}],
      ["get_recovery",{limit:25,next_token:firstA.next_token}],["get_sleep",{limit:25,next_token:manualA.next_token}],
      ["get_cycles",{auto_page:true,next_token:legacy}]]){
      const stale=await h.call(d,A,name,args);
      assert.equal(stale.body.result.isError,true,name);
      assert.match(stale.body.result.content[0].text,/not valid/);
    }
    const rest=await h.rest(d,A,"/v1/whoop/recovery?next_token="+encodeURIComponent(firstA.next_token));
    assert.equal(rest.status,400);
    assert.equal(w.calls.length,n,"no WHOOP request for a pre-reconnect cursor");
    // B is untouched by A's reconnect.
    assert.equal(generation(d,B),0);
    assert.equal(content(await h.call(d,B,"get_recovery",{auto_page:true,next_token:firstB.next_token})).records.length,100);
    // A fresh sequence on the new connection pages to the end, new account only.
    const got=[];let cursor=null;
    do{const out=content(await h.call(d,A,"get_recovery",cursor?{auto_page:true,next_token:cursor}:{auto_page:true}));
      assert.ok(out.records.every(r=>r.account==="access2-"+A));got.push(...idx(out.records));cursor=out.next_token;}while(cursor);
    assert.deepEqual(got,range(0,TOTAL));
  }finally{d.close();}
});

test("reconnect with disconnect: disconnect and the callback each bump the generation; a cursor from between is rejected too",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),h=harness(w);
    const before=content(await h.call(d,B,"get_workouts",{auto_page:true}));
    assert.equal(content(await h.call(d,B,"disconnect_whoop",{})).disconnected,true);
    assert.equal(generation(d,B),1);
    // A cursor sealed at generation 1 (after disconnect, before reconnect).
    const between=await sealCursor({env:baseEnv,userId:B,resource:"workouts",query:{start:null,end:null},whoopToken:btoa("workouts:100"),depth:4,generation:1,now:()=>Date.now()+2000});
    await new Promise(r=>setTimeout(r,1100)); // revoked_at and state times have one-second precision
    assert.equal((await reconnect(d,B,"access2-"+B)).connected,true);
    assert.equal(generation(d,B),2);
    const n=w.calls.length;
    for(const cursor of [before.next_token,between]){
      const stale=await h.call(d,B,"get_workouts",{auto_page:true,next_token:cursor});
      assert.equal(stale.body.result.isError,true);
    }
    assert.equal(w.calls.length,n);
    const fresh=content(await h.call(d,B,"get_workouts",{auto_page:true}));
    assert.ok(fresh.records.every(r=>r.account==="access2-"+B));
    assert.equal(content(await h.call(d,B,"get_workouts",{auto_page:true,next_token:fresh.next_token})).records.length,100);
  }finally{d.close();}
});

test("reconnect: a callback that stores nothing (seat limit, revoked state) does not bump; before 0016 everything still works",async()=>{
  // Seat limit: the batch aborts, so the bump rolls back with it.
  const users=[[A,"developer"],...Array.from({length:9},(_,i)=>[member(40+i),"public"])];
  let d=await db(users);
  try{
    d.sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(B,B);
    d.sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(B);
    await assert.rejects(reconnect(d,B,"access-"+B),/save failed|seats/i);
    assert.equal(generation(d,B),0);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_connection_generations WHERE user_id=?").get(B).n,0);
    // Revoked between authorize and callback: nothing stored, no bump.
    const start=await createWhoopAuthorization(d,A,oauthEnv);
    d.sqlite.prepare("INSERT INTO whoop_credential_revocations(user_id,revoked_at) VALUES(?,?)").run(A,"2099-01-01 00:00:00");
    const auth=new URL(start.authorization_url),url=new URL("https://whooplens.tech/api/whoop/callback");
    url.searchParams.set("state",auth.searchParams.get("state"));url.searchParams.set("code","synthetic-code-123");
    await assert.rejects(acceptWhoopCallback(d,url,oauthEnv,{fetcher:async()=>new Response(JSON.stringify({access_token:"x-"+A,refresh_token:"y",expires_in:3600}),{status:200})}),/revoked/);
    assert.equal(generation(d,A),0);
  }finally{d.close();}
  // Without the 0016 table: callback, disconnect and paging behave as before.
  d=await db(undefined,{generations:false});
  try{
    const w=fakeWhoop(),h=harness(w);
    const first=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(content(await h.call(d,A,"get_recovery",{auto_page:true,next_token:first.next_token})).records.length,100);
    assert.equal((await reconnect(d,A,"access2-"+A)).connected,true);
    assert.equal(content(await h.call(d,B,"disconnect_whoop",{})).disconnected,true);
  }finally{d.close();}
});

test("reconnect: cursors stay bound to member and endpoint; another member's generation never applies",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),h=harness(w);
    await reconnect(d,A,"access2-"+A);await reconnect(d,A,"access3-"+A);
    assert.equal(generation(d,A),2);
    const a=content(await h.call(d,A,"get_sleep",{auto_page:true}));
    // B (generation 0) cannot use A's generation-2 cursor, nor A on another endpoint.
    const n=w.calls.length;
    assert.equal((await h.call(d,B,"get_sleep",{auto_page:true,next_token:a.next_token})).body.result.isError,true);
    assert.equal((await h.call(d,A,"get_cycles",{auto_page:true,next_token:a.next_token})).body.result.isError,true);
    assert.equal(w.calls.length,n);
    const next=content(await h.call(d,A,"get_sleep",{auto_page:true,next_token:a.next_token}));
    assert.ok(next.records.every(r=>r.account==="access3-"+A));
    // An unreadable stored generation fails closed.
    d.sqlite.prepare("UPDATE whoop_connection_generations SET generation='x' WHERE user_id=?").run(A);
    assert.equal((await h.call(d,A,"get_sleep",{auto_page:true,next_token:next.next_token})).body.result.isError,true);
  }finally{d.close();}
});

test("reconnect mid-call: a reconnect without disconnect between pages drops the in-flight page (generation re-check)",async()=>{
  const d=await db();
  try{
    // A reconnect over the existing connection, as acceptWhoopCallback's batch
    // writes it: new credentials and a generation bump, revoked_at untouched.
    let armed=false;
    const swap=()=>{armed=false;d.sqlite.prepare("INSERT INTO whoop_connection_generations(user_id,generation) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1").run(A);};
    const w=fakeWhoop({fail:({bearer,call})=>{if(armed&&bearer==="access-"+A&&call>=2)swap();return null;}}),h=harness(w);
    armed=true;
    const out=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(out.records.length,25,"only the page fetched before the reconnect");
    assert.equal(out.complete,false);
    assert.equal(out.incomplete_reason,"connection_changed");
    assert.equal(out.next_token,null);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_credential_revocations").get().n,0,"marker never changed");
    // Manual page: the page is not returned at all.
    const w2=fakeWhoop({fail:()=>{swap();return null;}}),h2=harness(w2);
    const manual=await h2.call(d,A,"get_sleep",{limit:25});
    assert.equal(manual.body.result.isError,true);
    assert.equal(manual.body.result.structuredContent,undefined);
    // B is unaffected and a fresh sequence for A works.
    assert.equal(content(await h2.call(d,B,"get_sleep",{auto_page:true})).records.length,100);
    const fresh=content(await harness(fakeWhoop()).call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(fresh.records.length,100);assert.ok(fresh.next_token);
  }finally{d.close();}
});

test("rollout: cursors issued before 0016, and reconnects by pre-0016 code, cannot continue once 0016 exists (Codex P2 on 6968b7d)",async()=>{
  // Schema-first window: the table exists but the old Worker still serves.
  // Old code seals cursors without a generation and reconnects without a bump.
  const d=await db(undefined,{generations:false});
  try{
    const w=fakeWhoop(),h=harness(w);
    // This branch's code without the table seals cursors without a generation.
    const early=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    const old=await sealCursor({env:baseEnv,userId:A,resource:"sleep",query:{start:null,end:null},whoopToken:btoa("sleep:100"),depth:4});
    applyGenerations(d);
    // A reconnect that bypasses the bump (pre-0016 code): credentials replaced, no row.
    await connect(d.sqlite,A,"public","access2-"+A);
    assert.equal(generation(d,A),0);
    const n=w.calls.length;
    for(const [name,cursor] of [["get_recovery",early.next_token],["get_sleep",old]]){
      const stale=await h.call(d,A,name,{auto_page:true,next_token:cursor});
      assert.equal(stale.body.result.isError,true,name);
      assert.match(stale.body.result.content[0].text,/not valid/);
    }
    assert.equal(w.calls.length,n,"no WHOOP request for a generation-less cursor");
    // A fresh sequence works and its cursor continues.
    const fresh=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(content(await h.call(d,A,"get_recovery",{auto_page:true,next_token:fresh.next_token})).records.length,100);
  }finally{d.close();}
});

test("rollout: the bump is always in the credential batch; without the table the batch is retried without it",async()=>{
  const d=await db(undefined,{generations:false});
  try{
    const seen=[];const batch=d.batch.bind(d);
    d.batch=async statements=>{seen.push(statements.length);return batch(statements);};
    assert.equal((await reconnect(d,A,"access2-"+A)).connected,true);
    // seen[0] is the authorize-state batch. The callback's first attempt carried
    // the bump and failed as a whole; the retry did not carry it.
    assert.equal(seen.length,3);assert.equal(seen[1],seen[2]+1);
    assert.equal(d.sqlite.prepare("SELECT encrypted_access_token<>'' ok FROM whoop_connections WHERE user_id=?").get(A).ok,1);
    // Once the table exists, one batch with the bump.
    applyGenerations(d);seen.length=0;
    await new Promise(r=>setTimeout(r,5));
    assert.equal((await reconnect(d,A,"access3-"+A)).connected,true);
    assert.equal(seen.length,2,"authorize + one callback batch");assert.equal(generation(d,A),1);
    // Other batch failures are not retried.
    d.batch=async()=>{throw Error("D1_ERROR: Public WHOOP seats are full");};
    await assert.rejects(reconnect(d,B,"access2-"+B),/seats are full/);
  }finally{d.close();}
});

test("limits: a daily limit returns no cursor it would outlive, and says to restart (Codex P2 on 0e50f99)",async()=>{
  const d=await db();
  try{
    const {CURSOR_TTL_MS}=await import("../src/history-pagination.mjs");
    assert.equal(CURSOR_TTL_MS,3600_000,"memberLimitMessage assumes one-hour cursors");
    const w=fakeWhoop(),clock={t:T0},h=harness(w,clock,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"100",WHOOP_MEMBER_LIMIT_PER_DAY:"6"});
    const first=content(await h.call(d,A,"get_recovery",{auto_page:true}));
    assert.equal(first.records.length,100);
    const second=content(await quietly(()=>h.call(d,A,"get_recovery",{auto_page:true,next_token:first.next_token})));
    assert.deepEqual(idx(second.records),range(100,150),"partial records are still returned");
    assert.equal(second.incomplete_reason,"rate_limited");assert.equal(second.rate_limit_scope,"member");
    assert.ok(second.retry_after_seconds*1000>=CURSOR_TTL_MS);
    assert.equal(second.next_token,null,"no cursor that expires before the retry");
    assert.equal(second.complete,false);
    const blocked=await quietly(()=>h.call(d,A,"get_cycles",{limit:25}));
    const text=blocked.body.result.content[0].text;
    assert.match(text,/per day \(UTC\)/);assert.match(text,/request the first page again without next_token/);
    assert.doesNotMatch(text,/retry the same call/);
    // A minute limit keeps its cursor and its "retry the same call" advice.
    const m=harness(w,clock,{WHOOP_MEMBER_LIMIT_PER_MINUTE:"1"});
    const minute=await quietly(()=>m.call(d,B,"get_cycles",{limit:25}).then(()=>m.call(d,B,"get_cycles",{limit:25})));
    assert.match(minute.body.result.content[0].text,/retry the same call\. A next_token stays valid for one hour after it was issued\./);
  }finally{d.close();}
});

test("rollback and re-apply of 0016: cursors from before the drop or while it was absent stay rejected (Codex P2 on 172cf62)",async()=>{
  const d=await db();
  try{
    const w=fakeWhoop(),h=harness(w);
    const before=content(await h.call(d,A,"get_sleep",{auto_page:true}));
    d.sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    d.sqlite.exec(rollback("0016_whoop_connection_generations.down.sql"));
    // While the table is absent: a reconnect without disconnect leaves no bump,
    // and new cursors carry no generation.
    assert.equal((await reconnect(d,A,"access2-"+A)).connected,true);
    const absent=content(await h.call(d,A,"get_cycles",{auto_page:true}));
    assert.ok(absent.records.every(r=>r.account==="access2-"+A));
    await new Promise(r=>setTimeout(r,1100));
    d.sqlite.exec(migration(GENERATIONS));
    const n=w.calls.length;
    for(const [name,cursor] of [["get_sleep",before.next_token],["get_cycles",absent.next_token]]){
      const stale=await h.call(d,A,name,{auto_page:true,next_token:cursor});
      assert.equal(stale.body.result.isError,true,name);
      assert.match(stale.body.result.content[0].text,/not valid/);
    }
    assert.equal(w.calls.length,n,"rejected before any WHOOP request");
    const fresh=content(await h.call(d,A,"get_sleep",{auto_page:true}));
    assert.ok(fresh.records.every(r=>r.account==="access2-"+A));
    assert.equal(content(await h.call(d,A,"get_sleep",{auto_page:true,next_token:fresh.next_token})).records.length,100);
  }finally{d.close();}
});
