import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createWhoopAuthorization, acceptWhoopCallback } from "../src/whoop-oauth.mjs";
import { whoopStartHttp, WHOOP_START } from "../src/whoop-start.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { d1Database } from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base=Date.parse("2026-11-01T14:00:00Z");
const key=randomBytes(32).toString("base64url");
const env={
  WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret",
  WHOOP_REDIRECT_URI:"https://whooplens.tech/api/whoop/callback",
  WHOOP_TOKEN_AES256_KEY:key,WHOOP_LENS_DEVELOPER_USER_ID:A,
  MIGRATION_API_ENABLED:"true",WHOOP_OAUTH_ENABLED:"true",
  WHOOP_CONNECT_BROWSER_BINDING:"true"
};
const migration=name=>readFileSync(new URL("../migrations/"+name,import.meta.url),"utf8");
function fixture(){
  const sqlite=new DatabaseSync(":memory:");
  for(const name of ["0001_initial.sql","0002_enforce_seat_limits.sql",
    "0008_whoop_credential_revocations.sql","0026_whoop_oauth_browser_binding.sql"])
    sqlite.exec(migration(name));
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
  }
  return {sqlite,close(){sqlite.close();},...d1Database(sqlite)};
}
const tokenFetcher=()=>{
  const calls={n:0};
  const fetcher=async()=>{calls.n++;return new Response(JSON.stringify(
    {access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_in:3600,scope:"offline"}),
    {status:200,headers:{"content-type":"application/json"}});};
  return {fetcher,calls};
};
const startState=start=>{
  const u=new URL(start.authorization_url);
  assert.equal(u.origin+u.pathname,"https://whooplens.tech"+WHOOP_START);
  return u.searchParams.get("state");
};
const confirm=(state,headers={})=>new Request("https://whooplens.tech"+WHOOP_START,{method:"POST",
  headers:{"content-type":"application/x-www-form-urlencoded","origin":"https://whooplens.tech",...headers},
  body:new URLSearchParams({state})});
const cookieOf=response=>/^(__Host-wl_whoop=[A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie")||"")?.[1];
const callback=state=>new URL("https://whooplens.tech/api/whoop/callback?"+new URLSearchParams({state,code:"test-whoop-code-123"}));
const connections=d=>d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections").get().c;
const pending=d=>d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_oauth_states").get().c;

test("binding off keeps the direct WHOOP authorization link and unbound callback",async()=>{
  const d=fixture();
  try{
    const off={...env,WHOOP_CONNECT_BROWSER_BINDING:"false"};
    const start=await createWhoopAuthorization(d,A,off,{now:()=>base});
    const u=new URL(start.authorization_url);
    assert.equal(u.origin,"https://api.prod.whoop.com");
    const {fetcher}=tokenFetcher();
    await acceptWhoopCallback(d,callback(u.searchParams.get("state")),off,{fetcher,now:()=>base});
    assert.equal(connections(d),1);
    const res=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+"?state="+"A".repeat(43)),{...off,DB:d});
    assert.equal(res.status,503);
  }finally{d.close();}
});

test("start page warns, changes nothing on GET, and is safe for link previews",async()=>{
  const d=fixture();
  try{
    const state=startState(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    const res=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+"?state="+state),{...env,DB:d},{now:()=>base});
    assert.equal(res.status,200);
    const html=await res.text();
    assert.match(html,/If someone sent you this link, do not continue/);
    assert.match(html,/method="post"/);
    assert.equal(res.headers.get("set-cookie"),null);
    // A no-referrer page makes browsers submit the form with `Origin: null`
    // (production, Nov 1 2026). Only the confirmation page uses same-origin.
    assert.equal(res.headers.get("referrer-policy"),"same-origin");
    assert.equal(d.sqlite.prepare("SELECT browser_hash FROM whoop_oauth_states").get().browser_hash,null);
    for(const bad of ["","?state=short","?state="+state+"&state="+state,"?state="+"Z".repeat(43)]){
      const r=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+bad),{...env,DB:d},{now:()=>base});
      assert.equal(r.status,400,bad);
    }
    const late=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+"?state="+state),{...env,DB:d},{now:()=>base+11*60_000});
    assert.equal(late.status,400);
  }finally{d.close();}
});

test("confirming binds one browser, redirects to WHOOP and cannot be repeated",async()=>{
  const d=fixture();
  try{
    const state=startState(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    const res=await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base});
    assert.equal(res.status,303);
    const to=new URL(res.headers.get("location"));
    assert.equal(to.origin+to.pathname,"https://api.prod.whoop.com/oauth/oauth2/auth");
    assert.equal(to.searchParams.get("state"),state);
    assert.equal(to.searchParams.get("redirect_uri"),"https://whooplens.tech/api/whoop/callback");
    const set=res.headers.get("set-cookie");
    assert.match(set,/^__Host-wl_whoop=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const stored=d.sqlite.prepare("SELECT browser_hash FROM whoop_oauth_states").get().browser_hash;
    assert.match(stored,/^[0-9a-f]{64}$/);
    assert.ok(!set.includes(stored));
    const again=await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base});
    assert.equal(again.status,409);
    assert.equal(again.headers.get("location"),null);
    assert.equal(again.headers.get("set-cookie"),null);
    assert.equal(d.sqlite.prepare("SELECT browser_hash FROM whoop_oauth_states").get().browser_hash,stored);
  }finally{d.close();}
});

test("confirmation rejects cross-site posts, extra fields and inactive members",async()=>{
  const d=fixture();
  try{
    const state=startState(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    const cross=await whoopStartHttp(confirm(state,{origin:"https://attacker.invalid"}),{...env,DB:d},{now:()=>base});
    assert.equal(cross.status,403);
    // The fix is the page's referrer policy, not a looser check: "null" stays rejected.
    const opaque=await whoopStartHttp(confirm(state,{origin:"null"}),{...env,DB:d},{now:()=>base});
    assert.equal(opaque.status,403);
    const extra=new Request("https://whooplens.tech"+WHOOP_START,{method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded",origin:"https://whooplens.tech"},body:"state="+state+"&user=x"});
    assert.equal((await whoopStartHttp(extra,{...env,DB:d},{now:()=>base})).status,400);
    const json=new Request("https://whooplens.tech"+WHOOP_START,{method:"POST",
      headers:{"content-type":"application/json",origin:"https://whooplens.tech"},body:JSON.stringify({state})});
    assert.equal((await whoopStartHttp(json,{...env,DB:d},{now:()=>base})).status,400);
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(A);
    assert.equal((await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base})).status,400);
    assert.equal(d.sqlite.prepare("SELECT browser_hash FROM whoop_oauth_states").get().browser_hash,null);
  }finally{d.close();}
});

test("a forwarded or leaked state cannot be completed from another browser",async()=>{
  const d=fixture();
  try{
    const {fetcher,calls}=tokenFetcher();
    const state=startState(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    // Unconfirmed: no browser has bound the state yet.
    await assert.rejects(acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie:null}),/Invalid or expired/);
    const cookie=cookieOf(await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base}));
    assert.ok(cookie);
    const other="__Host-wl_whoop="+randomBytes(32).toString("base64url");
    await assert.rejects(acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie:null}),/Invalid or expired/);
    await assert.rejects(acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie:other}),/Invalid or expired/);
    await assert.rejects(acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie:"__Host-wl_whoop=bad"}),/Invalid or expired/);
    // Failed attempts never consume the state or reach WHOOP.
    assert.equal(pending(d),1);
    assert.equal(calls.n,0);
    const answer=await acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie:"theme=dark; "+cookie});
    assert.deepEqual(answer,{connected:true,seat_role:"developer"});
    assert.equal(calls.n,1);
    assert.equal(pending(d),0);
    assert.equal(d.sqlite.prepare("SELECT user_id FROM whoop_connections").get().user_id,A);
    await assert.rejects(acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie}),/Invalid or expired/);
  }finally{d.close();}
});

test("router serves the start page and an HTML callback result when binding is on",async()=>{
  const d=fixture();
  try{
    const router=createStagingRouter();
    const renv={...env,DB:d};
    const state=startState(await createWhoopAuthorization(d,B,env,{now:()=>Date.now()}));
    const page=await router(new Request("https://whooplens.tech"+WHOOP_START+"?state="+state),renv);
    assert.equal(page.status,200);
    assert.match(page.headers.get("content-type"),/text\/html/);
    const cookie=cookieOf(await router(confirm(state),renv));
    assert.ok(cookie);
    const failed=await router(new Request(callback(state)),renv);
    assert.equal(failed.status,400);
    assert.match(failed.headers.get("content-type"),/text\/html/);
    assert.match(await failed.text(),/same browser/);
    assert.equal(pending(d),1);
    let seen=null;
    const injected=createStagingRouter({whoopCallback:async(db,url,e,opts)=>{seen=opts.cookie;return {connected:true};}});
    const ok=await injected(new Request(callback(state),{headers:{cookie}}),renv);
    assert.equal(ok.status,200);
    assert.equal(seen,cookie);
    assert.match(await ok.text(),/WHOOP connected/);
    assert.match(ok.headers.get("set-cookie"),/Max-Age=0/);
    const off=await router(new Request("https://whooplens.tech"+WHOOP_START+"?state="+state),{...renv,WHOOP_CONNECT_BROWSER_BINDING:"false"});
    assert.equal(off.status,503);
  }finally{d.close();}
});

test("reopening the link or clicking again never breaks an authorization in progress",async()=>{
  const d=fixture();
  try{
    const {fetcher}=tokenFetcher();
    const state=startState(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    const cookie=cookieOf(await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base}));
    const reopened=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+"?state="+state),{...env,DB:d},{now:()=>base});
    assert.equal(reopened.status,409);
    assert.equal(reopened.headers.get("referrer-policy"),"no-referrer","only the confirmation page relaxes the referrer policy");
    assert.match(await reopened.text(),/Finish signing in to WHOOP/);
    const invalid=await whoopStartHttp(new Request("https://whooplens.tech"+WHOOP_START+"?state="+"Z".repeat(43)),{...env,DB:d},{now:()=>base});
    assert.equal(invalid.status,400);
    for(const r of [reopened,invalid,await whoopStartHttp(confirm(state),{...env,DB:d},{now:()=>base})])
      assert.equal(r.headers.get("set-cookie"),null);
    const answer=await acceptWhoopCallback(d,callback(state),env,{fetcher,now:()=>base,cookie});
    assert.equal(answer.connected,true);
  }finally{d.close();}
});
