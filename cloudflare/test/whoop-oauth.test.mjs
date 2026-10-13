import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createWhoopAuthorization,acceptWhoopCallback,revokeWhoopConnection } from "../src/whoop-oauth.mjs";
import { openWhoopToken } from "../src/token-crypto.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { d1Prepare, d1Database } from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base=Date.parse("2026-10-11T14:00:00Z");
const key=randomBytes(32).toString("base64url");
const env={
  WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret",
  WHOOP_REDIRECT_URI:"https://whooplens.tech/api/whoop/callback",
  WHOOP_TOKEN_AES256_KEY:key,
  WHOOP_LENS_DEVELOPER_USER_ID:A,
  MIGRATION_API_ENABLED:"true",WHOOP_OAUTH_ENABLED:"true"
};
const sql=readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8");
const cap=readFileSync(new URL("../migrations/0002_enforce_seat_limits.sql",import.meta.url),"utf8");
const revocations=readFileSync(new URL("../migrations/0008_whoop_credential_revocations.sql",import.meta.url),"utf8");
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
function fixture(){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(sql);sqlite.exec(cap);sqlite.exec(revocations);
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
  }
  return {
    sqlite,close(){sqlite.close();},
    ...d1Database(sqlite)
  };
}
function callbackUrl(start){
  const auth=new URL(start.authorization_url);
  const callback=new URL("https://whooplens.tech/api/whoop/callback");
  callback.searchParams.set("state",auth.searchParams.get("state"));
  callback.searchParams.set("code","test-whoop-code-123");
  return callback;
}
test("WHOOP connect authorizes only an explicitly active invited identity",async()=>{
  const d=fixture();
  try{
    const start=await createWhoopAuthorization(d,A,env,{now:()=>base});
    const u=new URL(start.authorization_url);
    assert.equal(u.origin,"https://api.prod.whoop.com");
    assert.equal(u.pathname,"/oauth/oauth2/auth");
    assert.equal(u.searchParams.get("client_id"),"synthetic-client");
    assert.equal(u.searchParams.get("redirect_uri"),"https://whooplens.tech/api/whoop/callback");
    assert.equal(u.searchParams.get("response_type"),"code");
    assert.match(u.searchParams.get("scope"),/read:recovery/);
    const states=d.sqlite.prepare("SELECT * FROM whoop_oauth_states").all();
    assert.equal(states.length,1);
    assert.notEqual(states[0].state_hash,u.searchParams.get("state"));
    assert.equal(states[0].state_hash.length,64);
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(B);
    await assert.rejects(createWhoopAuthorization(d,B,env,{now:()=>base}),/Membership required/);
    await assert.rejects(createWhoopAuthorization(d,A,{...env,WHOOP_REDIRECT_URI:"https://wrong.test/callback"}),/redirect/);
  }finally{d.close();}
});
test("one-time WHOOP callback stores encrypted developer tokens and refuses replay",async()=>{
  const d=fixture();
  try{
    const start=await createWhoopAuthorization(d,A,env,{now:()=>base});
    let calls=0;
    const fetcher=async(url,options)=>{
      calls++;
      assert.equal(url,"https://api.prod.whoop.com/oauth/oauth2/token");
      assert.equal(options.method,"POST");
      assert.equal(options.redirect,"manual");
      assert.equal(options.body.get("grant_type"),"authorization_code");
      assert.equal(options.body.get("redirect_uri"),"https://whooplens.tech/api/whoop/callback");
      return json({access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_in:3600,scope:"offline"});
    };
    const url=callbackUrl(start);
    const answer=await acceptWhoopCallback(d,url,env,{fetcher,now:()=>base});
    assert.deepEqual(answer,{connected:true,seat_role:"developer"});
    const data=d.sqlite.prepare("SELECT * FROM whoop_connections WHERE user_id=?").get(A);
    assert.equal(data.seat_role,"developer");
    assert.equal(data.encryption_key_version,"v1");
    assert.doesNotMatch(JSON.stringify(data),/synthetic-access|synthetic-refresh/);
    assert.equal(await openWhoopToken(data.encrypted_access_token,{userId:A,purpose:"access",key}),"synthetic-access");
    assert.equal(await openWhoopToken(data.encrypted_refresh_token,{userId:A,purpose:"refresh",key}),"synthetic-refresh");
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_oauth_states").get().c,0);
    await assert.rejects(acceptWhoopCallback(d,url,env,{fetcher,now:()=>base}),/Invalid or expired WHOOP state/);
    assert.equal(calls,1);
  }finally{d.close();}
});
test("callback rejects expired, disabled, forged and cross-domain states before network calls",async()=>{
  const d=fixture();
  try{
    let hits=0;const fetcher=async()=>{hits++;throw Error("no network");};
    const first=callbackUrl(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    await assert.rejects(acceptWhoopCallback(d,first,env,{fetcher,now:()=>base+11*60_000}),/expired/);
    const second=callbackUrl(await createWhoopAuthorization(d,B,env,{now:()=>base}));
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(B);
    await assert.rejects(acceptWhoopCallback(d,second,env,{fetcher,now:()=>base}),/Membership required/);
    const third=callbackUrl(await createWhoopAuthorization(d,A,env,{now:()=>base}));
    third.hostname="attacker.invalid";
    await assert.rejects(acceptWhoopCallback(d,third,env,{fetcher,now:()=>base}),/origin/);
    const forged=new URL("https://whooplens.tech/api/whoop/callback?state="+("A".repeat(43))+"&code=forged");
    await assert.rejects(acceptWhoopCallback(d,forged,env,{fetcher,now:()=>base}),/Invalid or expired/);
    assert.equal(hits,0);
  }finally{d.close();}
});
test("seat limits are atomic SQLite constraints; 9 public and 1 developer maximum",()=>{
  const d=fixture();
  try {
    for(let i=0;i<10;i++){
      const id="00000000-0000-4000-8000-00000000000"+i;
      d.sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
      const role=i===9?"developer":"public";
      d.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
        .run(id,"2027-01-01","sealed","sealed","v1",role);
    }
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE seat_role='public'").get().c,9);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE seat_role='developer'").get().c,1);
    assert.throws(()=>d.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
      .run(A,"2027-01-01","sealed","sealed","v1","public"),/Public WHOOP seats/);
    assert.throws(()=>d.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
      .run(A,"2027-01-01","sealed","sealed","v1","developer"),/UNIQUE/);
  }finally{d.close();}
});
test("OAuth HTTP routes remain disabled independently and require verified session to initiate",async()=>{
  const d=fixture();
  try {
    const incoming=(path)=>new Request("https://whooplens.tech"+path,{method:"GET",headers:{"Authorization":"Bearer synthetic-test"}});
    let initiated=0,completed=0,verified=0;
    const router=createStagingRouter({
      verifyIdentity:async()=>{verified++;return A;},
      whoopAuthorize:async()=>{initiated++;return {authorization_url:"https://mock.invalid/start"};},
      whoopCallback:async()=>{completed++;return {connected:true};}
    });
    const off={...env,DB:d,WHOOP_OAUTH_ENABLED:"false"};
    assert.equal((await router(incoming("/v1/whoop/connect"),off)).status,503);
    assert.equal((await router(incoming("/api/whoop/callback?state=test&code=test"),off)).status,503);
    assert.equal(initiated,0);assert.equal(completed,0);
    const on={...off,WHOOP_OAUTH_ENABLED:"true"};
    const a=await router(incoming("/v1/whoop/connect"),on);
    assert.equal(a.status,200);assert.equal(initiated,1);assert.equal(verified,2);
    const b=await router(incoming("/api/whoop/callback?state=test&code=test"),on);
    assert.equal(b.status,200);assert.equal(completed,1);
    // The callback is only authenticated via its one-time state, not a Supabase bearer.
    assert.equal(verified,2);
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(A);
    assert.equal((await router(incoming("/v1/whoop/connect"),on)).status,403);
    assert.equal(initiated,1);
  }finally{d.close();}
});

test("WHOOP OAuth token exchange rejects redirects without following them",async()=>{
  const d=fixture();try{
    const start=await createWhoopAuthorization(d,A,env,{now:()=>base});
    await assert.rejects(acceptWhoopCallback(d,callbackUrl(start),env,{
      now:()=>base,fetcher:async(_url,opts)=>{
        assert.equal(opts.redirect,"manual");
        return new Response(null,{status:302,headers:{location:"https://attacker.invalid/"}});
      }
    }),/WHOOP token exchange failed/);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?").get(A).c,0);
  }finally{d.close();}
});

test("disconnect deletes only the caller WHOOP credentials and pending state",async()=>{
  const d=fixture();try{
    for(const [id,hash] of [[A,"a".repeat(64)],[B,"b".repeat(64)]]){
      d.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
        .run(id,"2027-01-01","sealed-access","sealed-refresh","v1","public");
      d.sqlite.prepare("INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?,?,?)").run(hash,id,"2027-01-01");
    }
    const removed=await revokeWhoopConnection(d,A);
    assert.deepEqual(removed,{disconnected:true,removed:true});
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?").get(A).c,0);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_oauth_states WHERE user_id=?").get(A).c,0);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?").get(B).c,1);
    assert.equal(d.sqlite.prepare("SELECT encrypted_refresh_token t FROM whoop_connections WHERE user_id=?").get(B).t,"sealed-refresh");
    const again=await revokeWhoopConnection(d,A);
    assert.deepEqual(again,{disconnected:true,removed:false});
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(B);
    await assert.rejects(revokeWhoopConnection(d,B),/Membership required/);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?").get(B).c,1);
  }finally{d.close();}
});
test("disconnect is atomic: a failed connection delete keeps pending states", async () => {
  const { revokeWhoopConnection } = await import("../src/whoop-oauth.mjs");
  const db = fixture();
  try {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.sqlite.prepare("INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?,?,?)")
      .run("a".repeat(64), A, "2999-01-01T00:00:00.000Z");
    db.sqlite.exec(`CREATE TRIGGER block_delete BEFORE DELETE ON whoop_connections
      BEGIN SELECT RAISE(ABORT,'synthetic'); END;`);
    db.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,'v1','public')")
      .run(A, "2999-01-01T00:00:00.000Z", "", "x", "y");
    await assert.rejects(revokeWhoopConnection(db, A));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM whoop_oauth_states").get().n, 1);
    db.sqlite.exec("DROP TRIGGER block_delete");
    assert.deepEqual(await revokeWhoopConnection(db, A), { disconnected: true, removed: true });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM whoop_oauth_states").get().n, 0);
  } finally { db.close(); }
});
test("an in-flight WHOOP callback cannot store credentials after disconnect",async()=>{
  const d=fixture();try{
    const start=await createWhoopAuthorization(d,A,env,{now:()=>base});
    const created=d.sqlite.prepare("SELECT created_at FROM whoop_oauth_states").get().created_at;
    const createdMs=Date.parse(String(created).replace(" ","T")+"Z");
    await assert.rejects(acceptWhoopCallback(d,callbackUrl(start),env,{
      now:()=>base,
      fetcher:async()=>{
        await revokeWhoopConnection(d,A,{now:()=>createdMs});
        return json({access_token:"should-not-save",refresh_token:"should-not-save",expires_in:3600});
      }
    }),/WHOOP authorization was revoked/);
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?").get(A).c,0);
    d.sqlite.prepare("UPDATE whoop_credential_revocations SET revoked_at='2020-01-01 00:00:00' WHERE user_id=?").run(A);
    const again=await createWhoopAuthorization(d,A,env,{now:()=>base+60000});
    const saved=await acceptWhoopCallback(d,callbackUrl(again),env,{
      now:()=>base+60000,
      fetcher:async()=>json({access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_in:3600})
    });
    assert.equal(saved.connected,true);
  }finally{d.close();}
});
test("pending WHOOP states are pruned and capped per member", async () => {
  const { createWhoopAuthorization } = await import("../src/whoop-oauth.mjs");
  const db = fixture();
  try {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.sqlite.prepare("INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?,?,?)")
      .run("e".repeat(64), A, "2000-01-01T00:00:00.000Z");
    let t = Date.parse("2026-10-11T12:00:00Z");
    const latest = [];
    for (let i = 0; i < 8; i++) {
      const r = await createWhoopAuthorization(db, A, env, { now: () => t + i * 1000 });
      latest.push(new URL(r.authorization_url).searchParams.get("state"));
    }
    const rows = db.sqlite.prepare("SELECT state_hash FROM whoop_oauth_states WHERE user_id=?").all(A);
    assert.equal(rows.length, 5);
    assert.ok(!rows.some(r => r.state_hash === "e".repeat(64)));
  } finally { db.close(); }
});
