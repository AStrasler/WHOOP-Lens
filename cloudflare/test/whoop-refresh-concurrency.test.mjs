// Regression: concurrent WHOOP token refresh (production burst 2026-10-24).
// Parallel tool calls at token expiry each sent the same stored refresh token
// to WHOOP. WHOOP rotates refresh tokens, so at most one use can succeed; the
// mock below also treats reuse of a rotated token as compromise and revokes
// that token family (an OAuth 2.0 security BCP behaviour; WHOOP's exact rule
// is not documented, so the mock is the model under test, not WHOOP itself).
// Synthetic members, tokens and records only.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { sealWhoopToken } from "../src/token-crypto.mjs";
import { callWhoop } from "../src/whoop-api.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { resetCaptureThrottle } from "../src/diagnostics.mjs";
import { d1Database } from "./d1-sqlite.mjs";

const M="cccccccc-cccc-4ccc-8ccc-cccccccccccc",OTHER="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const key=randomBytes(32).toString("base64url");
const FULL="offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
const env={MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true",DIAGNOSTICS_CAPTURE_ENABLED:"true",
  WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret-123",WHOOP_LENS_DEVELOPER_USER_ID:M};
const TOOLS=["get_recovery","get_sleep","get_cycles","get_workouts"];
async function fixture({expiredFor=[M],path=":memory:"}={}){
  resetCaptureThrottle();
  const s=new DatabaseSync(path);const dir=new URL("../migrations/",import.meta.url);
  for(const f of readdirSync(dir).filter(f=>f.endsWith(".sql")).sort())s.exec(readFileSync(new URL(f,dir),"utf8"));
  for(const [id,role] of [[M,"developer"],[OTHER,"public"]]){
    s.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    s.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
    // Last written an hour ago, as a connection due for refresh would be.
    s.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now','-1 hour'))")
      .run(id,new Date(Date.now()+(expiredFor.includes(id)?-5e3:3600e3)).toISOString(),FULL,
        await sealWhoopToken("a0-"+id,{userId:id,purpose:"access",key}),await sealWhoopToken("r0-"+id,{userId:id,purpose:"refresh",key}),"v1",role);
  }
  return {sqlite:s,...d1Database(s),close(){s.close();}};
}
// Mock WHOOP with refresh-token rotation and reuse detection.
function rotatingWhoop({delay=15,tokenEndpoint}={}){
  const live=new Set(),used=new Set(),family=new Map();let n=0;
  for(const id of [M,OTHER]){live.add("a0-"+id);family.set("a0-"+id,"r0-"+id);family.set("r0-"+id,"r0-"+id);}
  const log={refresh:0,api:[]};
  const revokeFamily=root=>{for(const [t,f] of family)if(f===root){live.delete(t);used.add(t);}};
  const fetch=async(raw,opts)=>{
    const u=new URL(raw);
    if(u.pathname==="/oauth/oauth2/token"){
      log.refresh++;
      const rt=new URLSearchParams(String(opts.body)).get("refresh_token");
      await new Promise(r=>setTimeout(r,delay));
      if(tokenEndpoint){const out=await tokenEndpoint(rt);if(out)return out;}
      const root=family.get(rt);
      if(used.has(rt)){if(root)revokeFamily(root);return new Response('{"error":"invalid_grant"}',{status:400});}
      used.add(rt);n++;
      const a="a"+n+"-x",r="r"+n+"-x";live.add(a);family.set(a,root);family.set(r,root);
      for(const [t,f] of family)if(f===root&&t.startsWith("a")&&t!==a)live.delete(t);
      return Response.json({access_token:a,refresh_token:r,expires_in:3600,scope:FULL});
    }
    const bearer=opts.headers.authorization.slice(7);log.api.push({path:u.pathname,ok:live.has(bearer)});
    if(!live.has(bearer))return new Response("{}",{status:401});
    return Response.json({records:[{id:"r1",end:new Date().toISOString()}],next_token:null});
  };
  return {log,fetch};
}
const router=(w,api=callWhoop,member=M)=>createStagingRouter({verifyIdentity:async()=>member,
  whoopRequest:(d,u,r,e,o)=>api(d,u,r,e,o,{fetcher:w.fetch,sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,25)))})});
const call=(route,db,name)=>route(new Request("https://staging.invalid/mcp",{method:"POST",
  headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:{limit:5}}})}),{...env,DB:db}).then(r=>r.json());
const codes=db=>db.sqlite.prepare("SELECT code FROM diagnostic_events WHERE outcome!='success'").all().map(x=>x.code);
const failed=r=>r.result?.isError===true;
const row=(db,id=M)=>db.sqlite.prepare("SELECT expires_at,encrypted_access_token a,encrypted_refresh_token r,updated_at FROM whoop_connections WHERE user_id=?").get(id);

test("burst of four reads at expiry in one isolate: one refresh, every read succeeds",async()=>{
  const db=await fixture(),w=rotatingWhoop(),route=router(w);
  try{
    const results=await Promise.all(TOOLS.map(t=>call(route,db,t)));
    assert.deepEqual(results.map(failed),[false,false,false,false]);
    assert.equal(w.log.refresh,1,"the stored refresh token is sent once");
    assert.deepEqual(codes(db),[]);
    // A later read uses the stored rotation without refreshing again.
    assert.equal(failed(await call(route,db,"get_sleep")),false);
    assert.equal(w.log.refresh,1);
  }finally{db.close();}
});
test("burst split across two isolates: the D1 lease keeps it to one refresh",async()=>{
  // A second module instance has its own in-flight map, like another isolate.
  const other=await import("../src/whoop-api.mjs?isolate=2");
  const db=await fixture(),w=rotatingWhoop({delay:40});
  try{
    const a=router(w),b=router(w,other.callWhoop);
    const results=await Promise.all(TOOLS.map((t,i)=>call(i%2?b:a,db,t)));
    assert.deepEqual(results.map(failed),[false,false,false,false]);
    assert.equal(w.log.refresh,1);
    assert.deepEqual(codes(db),[]);
    assert.doesNotMatch(String(row(db).updated_at),/^lease:/,"a stored rotation clears the lease marker");
  }finally{db.close();}
});
test("a refresh 429 releases the lease: row unchanged and the next call can refresh at once",async()=>{
  let limited=true;
  const db=await fixture(),w=rotatingWhoop({tokenEndpoint:()=>limited?new Response("{}",{status:429,headers:{"retry-after":"5"}}):null});
  try{
    const before=row(db),route=router(w);
    const r=await call(route,db,"get_recovery");
    assert.equal(failed(r),true);
    assert.match(r.result.content[0].text,/rate limiting/);
    assert.deepEqual(row(db),before,"tokens, expiry and updated_at restored");
    limited=false;
    assert.equal(failed(await call(route,db,"get_recovery")),false);
    assert.equal(w.log.refresh,2);
  }finally{db.close();}
});
test("lost refresh response: temporary failure, tokens kept; a rotated-away token then reads as rejected",async()=>{
  let lose=true;
  const db=await fixture();
  const w=rotatingWhoop({tokenEndpoint:()=>null});
  const inner=w.fetch;
  // WHOOP rotates, but the response never reaches the Worker.
  w.fetch=async(raw,opts)=>{const res=await inner(raw,opts);
    if(lose&&new URL(raw).pathname==="/oauth/oauth2/token"){lose=false;throw new TypeError("fetch failed");}return res;};
  try{
    const before=row(db),route=router(w);
    const first=await call(route,db,"get_recovery");
    assert.match(first.result.content[0].text,/could not renew/);
    assert.deepEqual(row(db),before);
    assert.deepEqual(codes(db),["whoop_refresh_failed"]);
    const second=await call(route,db,"get_recovery");
    assert.match(second.result.content[0].text,/could not renew/);
    assert.ok(codes(db).includes("whoop_refresh_rejected"),"a refused refresh token is not reported as temporary");
    assert.deepEqual(row(db).r,before.r,"stored credentials are never deleted");
  }finally{db.close();}
});
test("a fresh lease held elsewhere makes callers wait, a stale one is reclaimed, and leases are per member",async()=>{
  const db=await fixture({expiredFor:[M,OTHER]}),w=rotatingWhoop();
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(M);
    const route=router(w);
    const blocked=await call(route,db,"get_recovery");
    assert.equal(failed(blocked),true);
    assert.equal(w.log.refresh,0,"no second use of the claimed refresh token");
    // OTHER is not affected by M's lease.
    assert.equal(failed(await call(router(w,callWhoop,OTHER),db,"get_recovery")),false);
    assert.equal(w.log.refresh,1);
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now','-121 seconds') WHERE user_id=?").run(M);
    assert.equal(failed(await call(route,db,"get_recovery")),false);
    assert.equal(w.log.refresh,2);
  }finally{db.close();}
});
test("an unexpired token is used without refreshing, and a 401 read is not retried",async()=>{
  const db=await fixture({expiredFor:[]}),w=rotatingWhoop(),route=router(w);
  try{
    assert.equal(failed(await call(route,db,"get_cycles")),false);
    assert.equal(w.log.refresh,0);
    db.sqlite.prepare("UPDATE whoop_connections SET encrypted_access_token=? WHERE user_id=?")
      .run(await sealWhoopToken("revoked-access",{userId:M,purpose:"access",key}),M);
    const before=w.log.api.length;
    const r=await call(route,db,"get_cycles");
    assert.match(r.result.content[0].text,/rejected this connection's authorization/);
    assert.equal(w.log.api.length-before,1);
    assert.equal(w.log.refresh,0);
    assert.deepEqual(codes(db),["whoop_unauthorized_cycles"]);
  }finally{db.close();}
});
test("a caller that outwaits a live lease fails as temporary and leaves the row and marker alone",async()=>{
  const db=await fixture(),w=rotatingWhoop(),route=router(w);
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(M);
    const before=row(db);
    const r=await call(route,db,"get_sleep");
    assert.match(r.result.content[0].text,/could not renew/);
    assert.deepEqual(codes(db),["whoop_refresh_failed"],"retryable, not a rejected token");
    assert.deepEqual(row(db),before,"the holder's marker and tokens are untouched");
    assert.equal(w.log.refresh,0);assert.equal(w.log.api.length,0);
  }finally{db.close();}
});
test("key-rotation re-encryption never rewrites a row that is due for refresh (cannot clear a lease)",async()=>{
  const {migrateConnection}=await import("../src/token-migration.mjs");
  const db=await fixture();
  try{
    const next=randomBytes(32).toString("base64url");
    const keys={current:"k2",k1:key,k2:next};
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(M);
    const before=row(db);
    const full=db.sqlite.prepare("SELECT * FROM whoop_connections WHERE user_id=?").get(M);
    const outcome=await migrateConnection(db,M,full,keys).catch(e=>"error:"+e.message);
    assert.equal(outcome,"raced","the expires_at guard (5 min margin) excludes rows the lease can claim (60 s)");
    assert.deepEqual(row(db),before);
  }finally{db.close();}
});
// Virtual clock for a follower isolate: each 500 ms poll advances it.
// Fixed base: real timer overhead never leaks into the injected clock.
function virtualClock(){const base=Date.now();let offset=0;return {now:()=>base+offset,sleep:async ms=>{offset+=ms;await new Promise(r=>setTimeout(r,2));},advanced:()=>offset};}
const routerWith=(w,api,deps)=>createStagingRouter({verifyIdentity:async()=>M,
  whoopRequest:(d,u,r,e,o)=>api(d,u,r,e,o,{fetcher:w.fetch,...deps})});
test("a follower in another isolate outwaits a slow holder (over 4.5 s, under the 12 s fetch limit): one refresh, both succeed",async()=>{
  const other=await import("../src/whoop-api.mjs?isolate=3");
  let open;const gate=new Promise(r=>{open=r;});
  const db=await fixture(),w=rotatingWhoop({delay:1,tokenEndpoint:async()=>{await gate;return null;}});
  const clock=virtualClock();
  try{
    const holder=call(router(w),db,"get_recovery");
    while(!String(row(db).updated_at).startsWith("lease:"))await new Promise(r=>setTimeout(r,2));
    let settled=false;
    const follower=call(routerWith(w,other.callWhoop,clock),db,"get_sleep").finally(()=>{settled=true;});
    while(!settled&&clock.advanced()<8000)await new Promise(r=>setTimeout(r,2));
    assert.equal(settled,false,"the follower is still waiting 8 s into the holder's refresh");
    open();
    const results=await Promise.all([holder,follower]);
    assert.deepEqual(results.map(failed),[false,false]);
    assert.equal(w.log.refresh,1,"the follower never sends the refresh token");
    assert.ok(clock.advanced()>=8000&&clock.advanced()<=15500);
    assert.deepEqual(codes(db),[]);
  }finally{open();db.close();}
});
test("a stuck holder: the follower gives up at the holder deadline, inside the lease, without refreshing",async()=>{
  const other=await import("../src/whoop-api.mjs?isolate=4");
  const db=await fixture(),w=rotatingWhoop(),clock=virtualClock();
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(M);
    const before=row(db);
    const r=await call(routerWith(w,other.callWhoop,clock),db,"get_sleep");
    assert.equal(failed(r),true);
    assert.deepEqual(codes(db),["whoop_refresh_failed"]);
    assert.ok(clock.advanced()>=15000&&clock.advanced()<120000,"waits to the holder deadline, never past the lease");
    assert.deepEqual(row(db),before);assert.equal(w.log.refresh,0);
  }finally{db.close();}
});
test("a holder that gives up releases its followers at once",async()=>{
  const other=await import("../src/whoop-api.mjs?isolate=5");
  const db=await fixture(),w=rotatingWhoop(),clock=virtualClock();
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?").run(M);
    setTimeout(()=>db.sqlite.prepare("UPDATE whoop_connections SET updated_at=datetime('now','-1 hour') WHERE user_id=?").run(M),20);
    const r=await call(routerWith(w,other.callWhoop,clock),db,"get_sleep");
    assert.equal(failed(r),true);
    assert.ok(clock.advanced()<15000,"stops once the marker is gone");
    assert.equal(w.log.refresh,0);
  }finally{db.close();}
});
for(const [label,endpoint] of [
  ["network error",()=>{throw new TypeError("fetch failed");}],
  ["timeout",()=>{throw new DOMException("timed out","TimeoutError");}],
  ["malformed JSON",()=>new Response("not json",{status:200})]]){
  test(`shared refresh failure (${label}): every caller in the burst reports whoop_refresh_failed`,async()=>{
    const db=await fixture(),w=rotatingWhoop({tokenEndpoint:endpoint});
    try{
      const before=row(db),route=router(w);
      const results=await Promise.all(TOOLS.map(t=>call(route,db,t)));
      assert.deepEqual(results.map(failed),[true,true,true,true]);
      for(const r of results)assert.match(r.result.content[0].text,/could not renew/,"refresh-specific guidance, not generic unavailable data");
      assert.deepEqual([...new Set(codes(db))],["whoop_refresh_failed"],"no tool_failed (capture dedupes repeats)");
      assert.equal(w.log.refresh,1);
      assert.deepEqual(row(db),before,"tokens kept and lease released");
    }finally{db.close();}
  });
}
// L2: the holder's WHOOP call succeeds (WHOOP rotates r0 -> r1), then its D1
// write stalls. A caller from another isolate arrives `lateBy` later and sees
// the holder's marker and the old r0 ciphertext.
async function stalledHolder(lateBy,isolate){
  const other=await import("../src/whoop-api.mjs?isolate="+isolate);
  let release;const stall=new Promise(r=>{release=r;});let stalled=false;
  const db=await fixture(),w=rotatingWhoop({delay:1});
  const holderDb={...db,prepare(sql){const st=db.prepare(sql);
    if(!/SET encrypted_access_token=\?1,encrypted_refresh_token=\?2,expires_at=\?3/.test(sql))return st;
    return {bind(...v){st.bind(...v);return this;},async run(){stalled=true;await stall;return st.run();},first:(...a)=>st.first(...a),all:(...a)=>st.all(...a)};}};
  const holder=call(router(w),holderDb,"get_recovery");
  while(!stalled)await new Promise(r=>setTimeout(r,2));
  const late=virtualClock();await late.sleep(lateBy);
  const lateResult=await call(routerWith(w,other.callWhoop,late),db,"get_sleep");
  const lateCodes=codes(db),refreshesWhileStalled=w.log.refresh;
  release();await holder;
  const after=await call(routerWith(w,other.callWhoop,late),db,"get_cycles");
  const out={lateResult,lateCodes,refreshesWhileStalled,after,marker:row(db).updated_at,refresh:w.log.refresh};
  db.close();return out;
}
test("L2: a write stalled 31 s after WHOOP rotated: the late caller does not reuse r0, and the stored rotation then works",async()=>{
  const o=await stalledHolder(31_000,6);
  assert.equal(o.refreshesWhileStalled,1,"the original refresh token is sent to WHOOP once");
  assert.equal(failed(o.lateResult),true);
  assert.deepEqual(o.lateCodes,["whoop_refresh_failed"],"retryable, never whoop_refresh_rejected");
  assert.equal(failed(o.after),false,"after the write lands the stored rotation is used");
  assert.equal(o.refresh,1);
  assert.doesNotMatch(String(o.marker),/^lease:/);
});
test("L2 beyond the lease (stall over 120 s): a takeover's rejection re-reads state and is not reported as rejected",async()=>{
  const o=await stalledHolder(121_000,7);
  assert.equal(o.refreshesWhileStalled,2,"a takeover after the full lease is the bounded, documented limit");
  assert.ok(!o.lateCodes.includes("whoop_refresh_rejected"),"classified as a retryable refresh failure");
  assert.ok(o.lateCodes.includes("whoop_refresh_failed"));
});
test("same isolate: a caller sharing a stalled refresh gives up at the holder deadline, retryably, without a second refresh",async()=>{
  const mod=await import("../src/whoop-api.mjs?isolate=8");
  let release;const stall=new Promise(r=>{release=r;});let stalled=false;
  const db=await fixture(),w=rotatingWhoop({delay:1}),clock=virtualClock();
  const holderDb={...db,prepare(sql){const st=db.prepare(sql);
    if(!/SET encrypted_access_token=\?1,encrypted_refresh_token=\?2,expires_at=\?3/.test(sql))return st;
    return {bind(...v){st.bind(...v);return this;},async run(){stalled=true;await stall;return st.run();},first:(...a)=>st.first(...a),all:(...a)=>st.all(...a)};}};
  try{
    const holder=call(routerWith(w,mod.callWhoop,clock),holderDb,"get_recovery");
    while(!stalled)await new Promise(r=>setTimeout(r,2));
    let settled=false;
    const sharer=call(routerWith(w,mod.callWhoop,clock),db,"get_sleep").finally(()=>{settled=true;});
    for(let i=0;i<500&&!settled;i++)await new Promise(r=>setTimeout(r,2));
    assert.equal(settled,true,"the sharing caller is bounded like a cross-isolate follower");
    assert.equal(failed(await sharer),true);
    assert.deepEqual(codes(db),["whoop_refresh_failed"],"retryable, never rejected");
    assert.ok(clock.advanced()>=15000&&clock.advanced()<120000);
    assert.equal(w.log.refresh,1,"no second refresh");
    assert.match(String(row(db).updated_at),/^lease:/,"the holder keeps its lease");
    release();
    assert.equal(failed(await holder),false,"the holder still stores its rotation");
    assert.equal(failed(await call(routerWith(w,mod.callWhoop,clock),db,"get_cycles")),false);
    assert.equal(w.log.refresh,1);
  }finally{release();db.close();}
});
test("a failed stale-lease takeover is not repeated as retryable: the next 400 is whoop_refresh_rejected",async()=>{
  const db=await fixture(),clock=virtualClock();
  const w=rotatingWhoop({tokenEndpoint:()=>new Response('{"error":"invalid_grant"}',{status:400})});
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now','-200 seconds') WHERE user_id=?").run(M);
    const before=row(db),route=routerWith(w,callWhoop,clock);
    const first=await call(route,db,"get_recovery");
    assert.equal(failed(first),true);
    assert.deepEqual(codes(db),["whoop_refresh_failed"],"the first takeover keeps its recovery window");
    assert.notEqual(row(db).updated_at,before.updated_at,"the stale marker is not restored");
    assert.doesNotMatch(String(row(db).updated_at),/^lease:/,"no lease blocks the next attempt");
    const second=await call(route,db,"get_recovery");
    assert.equal(failed(second),true);
    assert.ok(codes(db).includes("whoop_refresh_rejected"),"bounded: the second 400 is a rejected connection");
    assert.equal(w.log.refresh,2);
    assert.deepEqual(row(db).r,before.r,"stored credentials are never deleted");
  }finally{db.close();}
});

// Mandatory burst scenarios: exactly one token request per member and burst.
test("ten simultaneous expired-token reads per member, two members: one refresh each, rotations persisted, members isolated",async()=>{
  const db=await fixture({expiredFor:[M,OTHER]}),w=rotatingWhoop({delay:30});
  try{
    const before={m:row(db,M),o:row(db,OTHER)};
    const reads=[];
    for(let i=0;i<10;i++){reads.push(call(router(w,callWhoop,M),db,TOOLS[i%4]));reads.push(call(router(w,callWhoop,OTHER),db,TOOLS[i%4]));}
    const results=await Promise.all(reads);
    assert.deepEqual(results.map(failed),Array(20).fill(false));
    assert.equal(w.log.refresh,2,"one token request per member");
    assert.notEqual(row(db,M).r,before.m.r,"member M's rotated refresh token is stored");
    assert.notEqual(row(db,OTHER).r,before.o.r,"the other member's rotation is stored separately");
    assert.equal(w.log.api.length,20);assert.ok(w.log.api.every(x=>x.ok),"every read used a live rotated token");
    assert.deepEqual(codes(db),[]);
  }finally{db.close();}
});
// Separate module instances (separate in-flight maps, like isolates), each with
// its own connection to one file-backed SQLite database: only the D1 lease can
// coordinate them. Single process, so this is not a production observation.
test("cross-instance on a shared file-backed SQLite database: ten reads over three instances and connections make one refresh",async()=>{
  const path=join(tmpdir(),"wl-refresh-"+randomUUID()+".db");
  const base=await fixture({path}),w=rotatingWhoop({delay:40});
  const conns=[base];
  for(let i=0;i<2;i++){const c=new DatabaseSync(path);c.exec("PRAGMA busy_timeout=2000");conns.push({sqlite:c,...d1Database(c),close(){c.close();}});}
  try{
    const mods=[{callWhoop},await import("../src/whoop-api.mjs?file-isolate=1"),await import("../src/whoop-api.mjs?file-isolate=2")];
    const before=row(base);
    const results=await Promise.all(Array.from({length:10},(_,i)=>call(router(w,mods[i%3].callWhoop),conns[i%3],TOOLS[i%4])));
    assert.deepEqual(results.map(failed),Array(10).fill(false));
    assert.equal(w.log.refresh,1,"exactly one token request across instances");
    assert.notEqual(row(conns[2]).r,before.r,"the rotation is visible through another connection");
    assert.doesNotMatch(String(row(conns[1]).updated_at),/^lease:/);
    assert.ok(w.log.api.every(x=>x.ok));
  }finally{for(const c of conns)c.close();rmSync(path,{force:true});rmSync(path+"-wal",{force:true});rmSync(path+"-shm",{force:true});}
});
test("a stale holder write never overwrites a newer rotation stored by another instance",async()=>{
  const db=await fixture(),w=rotatingWhoop({delay:1});
  try{
    // Another instance stores a newer rotation while this refresh is in flight.
    const newer=await sealWhoopToken("r-newer",{userId:M,purpose:"refresh",key});
    const inner=w.fetch;
    w.fetch=async(raw,opts)=>{const res=await inner(raw,opts);
      if(new URL(raw).pathname==="/oauth/oauth2/token")db.sqlite.prepare("UPDATE whoop_connections SET encrypted_refresh_token=? WHERE user_id=?").run(newer,M);
      return res;};
    await call(router(w),db,"get_recovery");
    assert.equal(row(db).r,newer,"the compare-and-set write lost and left the newer token in place");
  }finally{db.close();}
});
