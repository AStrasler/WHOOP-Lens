// WHOOP failures are reported by status and resource, with fixed sanitized
// diagnostic codes and safe member messages. Synthetic data only.
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

const M="cccccccc-cccc-4ccc-8ccc-cccccccccccc",OTHER="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const key=randomBytes(32).toString("base64url");
const env={MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true",DIAGNOSTICS_CAPTURE_ENABLED:"true",
  WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret-123",WHOOP_LENS_DEVELOPER_USER_ID:M};
const SECRET_BODY='{"error":"token synthetic-access-'+M+' rejected","hrv":42}';
async function fixture(){
  resetCaptureThrottle();
  const s=new DatabaseSync(":memory:");const dir=new URL("../migrations/",import.meta.url);
  for(const f of readdirSync(dir).filter(f=>f.endsWith(".sql")).sort())s.exec(readFileSync(new URL(f,dir),"utf8"));
  for(const [id,role] of [[M,"developer"],[OTHER,"public"]]){
    s.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    s.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
    s.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?,?)")
      .run(id,new Date(Date.now()+3600e3).toISOString(),"x",await sealWhoopToken("synthetic-access-"+id,{userId:id,purpose:"access",key}),
        await sealWhoopToken("synthetic-refresh-"+id,{userId:id,purpose:"refresh",key}),"v1",role);
  }
  return {sqlite:s,...d1Database(s),close(){s.close();}};
}
// History endpoints fail as configured; profile and body measurements work.
const whoop=fail=>async raw=>{
  const u=new URL(raw);
  if(u.pathname.endsWith("/user/profile/basic"))return Response.json({user_id:1,first_name:"Synthetic"});
  if(u.pathname.endsWith("/user/measurement/body"))return Response.json({height_meter:1.8});
  return fail();
};
const call=(db,fetcher,name,args={limit:5},member=M)=>createStagingRouter({verifyIdentity:async()=>member,
  whoopRequest:(d,u,r,e,o)=>callWhoop(d,u,r,e,o,{fetcher})})(new Request("https://staging.invalid/mcp",{method:"POST",
  headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),{...env,DB:db}).then(r=>r.json());
const rows=db=>db.sqlite.prepare("SELECT * FROM diagnostic_events").all();

const cases=[
  ["401",()=>new Response(SECRET_BODY,{status:401}),"auth","whoop_unauthorized",/^WHOOP rejected this connection's authorization when reading (recovery|sleep|workout|cycle) data\. Retry once; if it keeps failing, reconnect WHOOP in WhoopLens\./],
  ["403",()=>new Response(SECRET_BODY,{status:403}),"auth","whoop_forbidden",/^WHOOP denied access to (recovery|sleep|workout|cycle) data for this connection\./],
  ["404",()=>new Response(SECRET_BODY,{status:404}),"whoop_api","whoop_not_found",/^WHOOP did not find (recovery|sleep|workout|cycle) data for this request\./],
  ["502",()=>new Response(SECRET_BODY,{status:502}),"whoop_api","whoop_upstream_error",/^WHOOP is temporarily unavailable \(reading (recovery|sleep|workout|cycle) data\)\./],
  ["network",()=>{throw new TypeError("fetch failed "+SECRET_BODY);},"whoop_api","whoop_network_error",/^WHOOP is temporarily unavailable \(reading/],
  ["timeout",()=>{throw new DOMException("The operation timed out.","TimeoutError");},"whoop_api","whoop_timeout",/^WHOOP did not respond in time when reading/],
];
for(const [label,fail,category,code,message] of cases){
  test(`history ${label}: per-resource code, distinct safe message, profile still works`,async()=>{
    const db=await fixture();
    try{
      const fetcher=whoop(fail);
      const p=await call(db,fetcher,"get_profile",{});
      assert.notEqual(p.result.isError,true);
      for(const [tool,res] of [["get_recovery","recovery"],["get_sleep","sleep"],["get_workouts","workouts"],["get_cycles","cycles"]]){
        const r=await call(db,fetcher,tool);
        assert.equal(r.result.isError,true);
        const text=r.result.content[0].text;
        assert.match(text,message);
        assert.match(text,/No WHOOP data was returned/);
        assert.notEqual(text,"WHOOP data is unavailable for this connection.");
        for(const leak of ["synthetic-access","synthetic-refresh","hrv","42",M,"Bearer"])assert.equal(text.includes(leak),false,leak);
        assert.equal(r.result.structuredContent,undefined);
        const row=rows(db).find(x=>x.code===`${code}_${res}`);
        assert.ok(row,`${code}_${res} recorded`);
        assert.equal(row.category,category);assert.equal(row.subsystem,"whoop_api");assert.equal(row.user_key,M);
      }
      const dump=JSON.stringify(rows(db));
      for(const leak of ["synthetic-access","synthetic-refresh","hrv","rejected","fetch failed","timed out"])assert.equal(dump.includes(leak),false,leak);
      assert.equal(rows(db).some(x=>x.user_key===OTHER),false,"other member untouched");
      assert.ok(rows(db).every(x=>/^[a-z0-9_]{1,64}$/.test(x.code)));
    }finally{db.close();}
  });
}
test("WHOOP 429 is still reported as rate limiting, never as auth or missing data",async()=>{
  const db=await fixture();
  try{
    const r=await call(db,whoop(()=>new Response("{}",{status:429,headers:{"retry-after":"20"}})),"get_recovery");
    assert.match(r.result.content[0].text,/^WHOOP is rate limiting requests right now\. Wait about 20 seconds,/);
    assert.equal(rows(db).length,0,"rate-limit diagnostics are not written to D1");
  }finally{db.close();}
});
test("classification: every status and resource maps to a fixed code within the D1 CHECK",()=>{
  const e=x=>Object.assign(Error("WHOOP API request failed"),x);
  const longest=["profile","measurements","recovery","sleep","workouts","cycles"].flatMap(resource=>[
    e({status:401,resource}),e({status:403,resource}),e({status:404,resource}),e({status:500,resource}),
    e({status:0,network:"timeout",resource}),e({status:0,network:"network",resource}),e({status:418,resource})
  ].map(x=>classifyToolError(x,"get_recovery").code));
  assert.ok(longest.every(c=>/^[a-z0-9_]{1,64}$/.test(c)),longest.join());
  assert.equal(classifyToolError(e({status:401,resource:"measurements"}),"get_body_measurements").code,"whoop_unauthorized_measurements");
  assert.equal(classifyToolError(e({status:418,resource:"sleep"}),"get_sleep").code,"whoop_request_failed_sleep");
  // Unknown or unsafe resource strings never reach the code.
  assert.equal(classifyToolError(e({status:403,resource:"../x"}),"get_sleep").code,"whoop_forbidden");
  assert.equal(classifyToolError(e({status:429,resource:"sleep"}),"get_sleep").code,"whoop_rate_limited");
});
test("refresh failure has its own message and code",async()=>{
  const db=await fixture();
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET expires_at=? WHERE user_id=?").run(new Date(Date.now()-60e3).toISOString(),M);
    const fetcher=async raw=>new URL(raw).pathname.includes("/oauth/")?new Response(SECRET_BODY,{status:400}):Response.json({});
    const r=await call(db,fetcher,"get_recovery");
    assert.match(r.result.content[0].text,/^WhoopLens could not renew this connection's WHOOP authorization\./);
    // A 400 from the token endpoint is WHOOP refusing the stored refresh
    // token: not labelled temporary, and the member is not told to retry.
    assert.match(r.result.content[0].text,/retrying will not help; reconnect WHOOP in WhoopLens/);
    assert.doesNotMatch(r.result.content[0].text,/Retry shortly/);
    assert.doesNotMatch(r.result.content[0].text,/invalid_grant|refresh_token|SECRET/i);
    assert.ok(rows(db).some(x=>x.code==="whoop_refresh_rejected"));
    assert.equal(rows(db).some(x=>x.code==="whoop_refresh_failed"),false);
  }finally{db.close();}
});
for(const [label,tokenEndpoint] of [
  ["timeout",()=>{throw new DOMException("The operation timed out.","TimeoutError");}],
  ["network",()=>{throw new TypeError("fetch failed");}],
  ["malformed body",()=>new Response("not json "+SECRET_BODY,{status:200})],
]){
  test(`refresh ${label} is reported as a refresh failure; stored tokens untouched`,async()=>{
    const db=await fixture();
    try{
      db.sqlite.prepare("UPDATE whoop_connections SET expires_at=? WHERE user_id=?").run(new Date(Date.now()-60e3).toISOString(),M);
      const before=db.sqlite.prepare("SELECT encrypted_access_token,encrypted_refresh_token,expires_at FROM whoop_connections WHERE user_id=?").get(M);
      let api=0;
      const fetcher=async raw=>{if(new URL(raw).pathname.includes("/oauth/"))return tokenEndpoint();api++;return Response.json({});};
      const r=await call(db,fetcher,"get_recovery");
      assert.match(r.result.content[0].text,/^WhoopLens could not renew this connection's WHOOP authorization\./);
      assert.match(r.result.content[0].text,/Retry shortly/);
      assert.deepEqual(rows(db).map(x=>x.code),["whoop_refresh_failed"]);
      assert.equal(api,0,"no WHOOP API call without a token");
      assert.deepEqual(db.sqlite.prepare("SELECT encrypted_access_token,encrypted_refresh_token,expires_at FROM whoop_connections WHERE user_id=?").get(M),before);
      assert.equal(JSON.stringify(rows(db)).includes("fetch failed"),false);
    }finally{db.close();}
  });
}
test("a decryption or parse error with no refresh attempt is not relabelled",async()=>{
  const db=await fixture();
  try{
    db.sqlite.prepare("UPDATE whoop_connections SET encrypted_access_token='{bad' WHERE user_id=?").run(M);
    const r=await call(db,whoop(()=>Response.json({records:[]})),"get_recovery");
    assert.equal(r.result.isError,true);
    assert.equal(rows(db).some(x=>x.code==="whoop_refresh_failed"),false);
  }finally{db.close();}
});
