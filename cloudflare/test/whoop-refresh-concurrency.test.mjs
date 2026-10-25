// Regression: concurrent WHOOP token refresh (production burst 2026-10-24).
// Parallel tool calls at token expiry each sent the same stored refresh token
// to WHOOP. WHOOP rotates refresh tokens, so at most one use can succeed; the
// mock below also treats reuse of a rotated token as compromise and revokes
// that token family (an OAuth 2.0 security BCP behaviour; WHOOP's exact rule
// is not documented, so the mock is the model under test, not WHOOP itself).
// Synthetic members, tokens and records only.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
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
async function fixture({expiredFor=[M]}={}){
  resetCaptureThrottle();
  const s=new DatabaseSync(":memory:");const dir=new URL("../migrations/",import.meta.url);
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
    db.sqlite.prepare("UPDATE whoop_connections SET updated_at='lease:'||strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 seconds') WHERE user_id=?").run(M);
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
