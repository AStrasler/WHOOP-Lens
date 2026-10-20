// Token refresh requests offline (WHOOP's documented refresh payload) and
// stores the scope WHOOP returns. No retry, no extra refresh. Synthetic only.
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
async function fixture({expired=true}={}){
  resetCaptureThrottle();
  const s=new DatabaseSync(":memory:");const dir=new URL("../migrations/",import.meta.url);
  for(const f of readdirSync(dir).filter(f=>f.endsWith(".sql")).sort())s.exec(readFileSync(new URL(f,dir),"utf8"));
  for(const [id,role] of [[M,"developer"],[OTHER,"public"]]){
    s.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    s.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
    s.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?,?)")
      .run(id,new Date(Date.now()+(expired&&id===M?-60e3:3600e3)).toISOString(),FULL,
        await sealWhoopToken("old-access-"+id,{userId:id,purpose:"access",key}),await sealWhoopToken("old-refresh-"+id,{userId:id,purpose:"refresh",key}),"v1",role);
  }
  return {sqlite:s,...d1Database(s),close(){s.close();}};
}
// Mock WHOOP. history(u,bearer) answers history endpoints.
function whoop(opts={}){
  // Property presence, not a default: {scope:undefined} omits scope from the response.
  const scope=Object.hasOwn(opts,"scope")?opts.scope:FULL,history=opts.history;
  const log={refresh:[],api:[],scopeSent:[]};
  const fetch=async(raw,opts)=>{
    const u=new URL(raw);
    if(u.pathname==="/oauth/oauth2/token"){
      log.refresh.push(Object.fromEntries(new URLSearchParams(String(opts.body))));
      const out={access_token:"new-access",refresh_token:"new-refresh",expires_in:3600,token_type:"bearer"};
      if(scope!==undefined)out.scope=scope;
      log.scopeSent.push(Object.hasOwn(out,"scope"));
      return Response.json(out);
    }
    const bearer=opts.headers.authorization.slice(7);log.api.push({path:u.pathname,bearer});
    if(/profile|measurement/.test(u.pathname))return Response.json({user_id:1});
    return history?history(u,bearer):Response.json({records:[{id:"r1",end:new Date().toISOString()}],next_token:null});
  };
  return {log,fetch};
}
const call=(db,w,name,args={limit:5},member=M)=>createStagingRouter({verifyIdentity:async()=>member,
  whoopRequest:(d,u,r,e,o)=>callWhoop(d,u,r,e,o,{fetcher:w.fetch,sleep:async()=>{}})})(new Request("https://staging.invalid/mcp",{method:"POST",
  headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),{...env,DB:db}).then(r=>r.json());
const conn=(db,id=M)=>db.sqlite.prepare("SELECT scope,expires_at,encrypted_access_token AS a,encrypted_refresh_token AS r FROM whoop_connections WHERE user_id=?").get(id);
const codes=db=>db.sqlite.prepare("SELECT code FROM diagnostic_events").all().map(x=>x.code);

test("refresh sends scope=offline with the documented fields only, once, and the new token is used",async()=>{
  const db=await fixture(),w=whoop();
  try{
    const r=await call(db,w,"get_recovery");
    assert.notEqual(r.result.isError,true);
    assert.equal(w.log.refresh.length,1);
    const body=w.log.refresh[0];
    assert.deepEqual(Object.keys(body).sort(),["client_id","client_secret","grant_type","refresh_token","scope"]);
    assert.equal(body.scope,"offline");
    assert.equal(body.grant_type,"refresh_token");
    assert.equal(body.refresh_token,"old-refresh-"+M);
    assert.deepEqual(w.log.api.map(x=>x.bearer),["new-access"]);
  }finally{db.close();}
});
// The stored value before the refresh differs from FULL so the omitted case is distinguishable.
const PRIOR="offline read:profile read:recovery prior";
for(const [label,returned,stored,present] of [["full scope",FULL,FULL,true],["no scope in response",undefined,PRIOR,false],["narrowed scope","offline read:profile","offline read:profile",true]]){
  test(`stored scope after refresh: ${label}`,async()=>{
    const db=await fixture(),w=whoop({scope:returned});
    try{
      db.sqlite.prepare("UPDATE whoop_connections SET scope=? WHERE user_id=?").run(PRIOR,M);
      await call(db,w,"get_profile",{});
      assert.deepEqual(w.log.scopeSent,[present],"mock response scope presence");
      assert.equal(conn(db).scope,stored);
    }finally{db.close();}
  });
}
test("an unexpired token is used without any refresh request",async()=>{
  const db=await fixture({expired:false}),w=whoop();
  try{
    for(const n of ["get_profile","get_recovery","get_sleep"])await call(db,w,n,n==="get_profile"?{}:{limit:5});
    assert.equal(w.log.refresh.length,0);
    assert.deepEqual([...new Set(w.log.api.map(x=>x.bearer))],["old-access-"+M]);
  }finally{db.close();}
});
for(const status of [401,403]){
  test(`history ${status} after a refresh: reported once, no retry, no second refresh`,async()=>{
    const db=await fixture(),w=whoop({history:()=>new Response('{"detail":"synthetic body"}',{status})});
    try{
      const p=await call(db,w,"get_profile",{});
      assert.notEqual(p.result.isError,true);
      const r=await call(db,w,"get_recovery");
      assert.equal(r.result.isError,true);
      assert.match(r.result.content[0].text,status===401?/^WHOOP rejected this connection's authorization when reading recovery data/:/^WHOOP denied access to recovery data/);
      assert.equal(r.result.content[0].text.includes("synthetic body"),false);
      assert.equal(w.log.refresh.length,1,"exactly one refresh for the expired token");
      assert.equal(w.log.api.filter(x=>x.path.endsWith("/recovery")).length,1,"no retry");
      assert.deepEqual(codes(db),[status===401?"whoop_unauthorized_recovery":"whoop_forbidden_recovery"]);
      const dump=JSON.stringify(db.sqlite.prepare("SELECT * FROM diagnostic_events").all());
      for(const leak of ["new-access","old-refresh","synthetic body","offline"])assert.equal(dump.includes(leak),false,leak);
    }finally{db.close();}
  });
}
test("member isolation: refreshing one member never touches another member's connection",async()=>{
  const db=await fixture(),w=whoop();
  try{
    const before=conn(db,OTHER);
    await call(db,w,"get_recovery");
    assert.deepEqual(conn(db,OTHER),before);
    assert.equal(w.log.refresh.every(b=>b.refresh_token==="old-refresh-"+M),true);
    // The other member's own call uses its own unexpired token, no refresh.
    await call(db,w,"get_recovery",{limit:5},OTHER);
    assert.equal(w.log.refresh.length,1);
    assert.equal(w.log.api.at(-1).bearer,"old-access-"+OTHER);
  }finally{db.close();}
});
test("pagination after a refresh: one refresh, sealed cursor, pages resume with the new token",async()=>{
  const db=await fixture();
  const w=whoop({history:u=>{const t=u.searchParams.get("nextToken");
    return Response.json(t?{records:[{id:"p2",end:new Date().toISOString()}],next_token:null}:{records:[{id:"p1",end:new Date().toISOString()}],next_token:"W2"});}});
  try{
    const first=JSON.parse((await call(db,w,"get_recovery",{limit:1})).result.content[0].text);
    assert.equal(typeof first.next_token,"string");assert.notEqual(first.next_token,"W2");
    const second=JSON.parse((await call(db,w,"get_recovery",{limit:1,next_token:first.next_token})).result.content[0].text);
    assert.deepEqual([...first.records,...second.records].map(r=>r.id),["p1","p2"]);
    assert.equal(w.log.refresh.length,1);
    assert.deepEqual([...new Set(w.log.api.map(x=>x.bearer))],["new-access"]);
  }finally{db.close();}
});
