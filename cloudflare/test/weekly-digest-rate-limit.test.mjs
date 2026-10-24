// Weekly digest: a rate-limited WHOOP read is reported as rate limiting, never
// as a missing connection or missing data (message and diagnostic code).
// Synthetic data only.
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { sealWhoopToken } from "../src/token-crypto.mjs";
import { callWhoop } from "../src/whoop-api.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { resetCaptureThrottle, classifyToolError } from "../src/diagnostics.mjs";
import { d1Database } from "./d1-sqlite.mjs";
const M="cccccccc-cccc-4ccc-8ccc-cccccccccccc",key=randomBytes(32).toString("base64url");
const base={MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true",DIAGNOSTICS_CAPTURE_ENABLED:"true",WEEKLY_DIGEST_ENABLED:"true",
  AI_SUMMARY_ENABLED:"true",STRESS_ESTIMATE_ENABLED:"true",WHOOP_MEMBER_LIMIT_PER_MINUTE:"25",WHOOP_MEMBER_LIMIT_PER_DAY:"1000",
  WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"c",WHOOP_CLIENT_SECRET:"synthetic-secret-123",WHOOP_LENS_DEVELOPER_USER_ID:M};
async function fixture(){
  const s=new DatabaseSync(":memory:");const dir=new URL("../migrations/",import.meta.url);
  for(const f of readdirSync(dir).filter(f=>f.endsWith(".sql")).sort())s.exec(readFileSync(new URL(f,dir),"utf8"));
  s.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(M,M);
  s.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(M);
  s.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?,?)")
    .run(M,new Date(Date.now()+3600e3).toISOString(),"x",await sealWhoopToken("at",{userId:M,purpose:"access",key}),await sealWhoopToken("rt",{userId:M,purpose:"refresh",key}),"v1","developer");
  return {sqlite:s,...d1Database(s),close(){s.close();}};
}
const day=i=>new Date(Date.now()-i*86400e3);
function records(path){
  const out=[];
  for(let i=1;i<=120;i++){const d=day(i),iso=d.toISOString();
    if(path.endsWith("recovery"))out.push({cycle_id:i,sleep_id:"s"+i,created_at:iso,updated_at:iso,score_state:"SCORED",score:{recovery_score:60,resting_heart_rate:55,hrv_rmssd_milli:50}});
    if(path.endsWith("sleep"))out.push({id:"s"+i,start:new Date(d-8*3600e3).toISOString(),end:iso,nap:false,score_state:"SCORED",score:{sleep_performance_percentage:85}});
    if(path.endsWith("cycle"))out.push({id:i,start:new Date(d-24*3600e3).toISOString(),end:iso,score_state:"SCORED",score:{strain:10}});
    if(path.endsWith("workout"))out.push({id:"w"+i,start:iso,end:iso,score_state:"SCORED",score:{strain:8}});}
  return out;
}
function whoop(fail){
  const w={calls:0};
  w.fetch=async raw=>{w.calls++;const u=new URL(raw);if(fail)return fail(u);
    const lim=Number(u.searchParams.get("limit")||10),off=Number(u.searchParams.get("nextToken")?.slice(1)||0);
    const all=records(u.pathname);return Response.json({records:all.slice(off,off+lim),next_token:off+lim<all.length?"o"+(off+lim):null});};
  return w;
}
const caller=(w,env)=>{
  const route=createStagingRouter({verifyIdentity:async()=>M,whoopRequest:(db,u,r,e,o)=>callWhoop(db,u,r,e,o,{fetcher:w.fetch})});
  return async(name,args)=>(await (await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env)).json());
};
const codes=db=>db.sqlite.prepare("SELECT subsystem||'/'||code AS c FROM diagnostic_events").all().map(r=>r.c);
const digests=db=>db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%digest%'").all()
  .reduce((n,{name})=>n+db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,0);

test("digest after summary calls exhausted the member budget reports the limit, not missing data",async()=>{
  resetCaptureThrottle();const db=await fixture(),w=whoop();
  try{
    const call=caller(w,{...base,DB:db});
    for(const n of ["get_recovery","get_sleep","get_cycles","get_recovery"])await call(n,{summary:true});
    const before=w.calls,d=await call("get_weekly_digest",{});
    assert.equal(w.calls,before,"no WHOOP request once the budget is spent");
    assert.equal(d.result.isError,true);
    const text=d.result.content[0].text;
    assert.match(text,/request limit \(25 WHOOP requests per minute\)/);
    assert.doesNotMatch(text,/unavailable for this connection|not connected|no data/i);
    // Rate-limit diagnostics are never written to D1; the old misclassification was.
    assert.deepEqual(codes(db).filter(x=>x.startsWith("weekly_digest/")),[]);
    assert.equal(digests(db),0,"nothing cached on failure");
  }finally{db.close();}
});
test("rate-limited digest errors classify as rate limiting, not missing data",()=>{
  const e=(extra)=>Object.assign(Error("x"),{status:429},extra);
  assert.deepEqual(classifyToolError(e({memberLimit:true}),"get_weekly_digest"),
    {category:"rate_limit",subsystem:"weekly_digest",code:"member_budget_exhausted",retryable:true,kind:"temporary"});
  assert.equal(classifyToolError(e({}),"get_weekly_digest").code,"whoop_rate_limited");
  // Still used for a real missing connection.
  assert.equal(classifyToolError(Error("digest"),"get_weekly_digest").code,"whoop_not_connected_or_no_data");
});
test("digest when WHOOP itself returns 429 reports WHOOP rate limiting",async()=>{
  resetCaptureThrottle();const db=await fixture(),w=whoop(()=>new Response("{}",{status:429,headers:{"retry-after":"30"}}));
  try{
    const d=await caller(w,{...base,DB:db})("get_weekly_digest",{});
    assert.equal(d.result.isError,true);
    assert.match(d.result.content[0].text,/^WHOOP is rate limiting requests right now\./);
    assert.deepEqual(codes(db).filter(x=>x.startsWith("weekly_digest/")),[]);
  }finally{db.close();}
});
test("digest within budget still succeeds",async()=>{
  resetCaptureThrottle();const db=await fixture(),w=whoop();
  try{
    const d=await caller(w,{...base,DB:db})("get_weekly_digest",{});
    assert.notEqual(d.result.isError,true);
    assert.ok(w.calls>0&&w.calls<=12);
    assert.deepEqual(codes(db),[]);
  }finally{db.close();}
});
test("a non-rate-limit digest failure for a connected member is not reported as missing data",async()=>{
  resetCaptureThrottle();const db=await fixture(),w=whoop(()=>new Response("{}",{status:503}));
  try{
    const d=await caller(w,{...base,DB:db})("get_weekly_digest",{});
    assert.equal(d.result.isError,true);
    // Per-resource code (diagnostic transparency): whichever WHOOP endpoint failed first.
    assert.equal(codes(db).length,1);
    assert.match(codes(db)[0],/^weekly_digest\/whoop_upstream_error_(recovery|sleep|workouts|cycles)$/);
  }finally{db.close();}
});
