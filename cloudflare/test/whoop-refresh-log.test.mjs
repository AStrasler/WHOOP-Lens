// RB-021: a successful WHOOP refresh emits one sanitized console line and no
// D1 diagnostic row. Synthetic ids and tokens only.
import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {sealWhoopToken} from "../src/token-crypto.mjs";
import {whoopAccessToken} from "../src/whoop-api.mjs";
import {d1Database} from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now=Date.parse("2026-10-11T12:00:00Z");
const key=randomBytes(32).toString("base64url");
const env={WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret"};
const schema=readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8")+
  readFileSync(new URL("../migrations/0008_whoop_credential_revocations.sql",import.meta.url),"utf8");
async function fixture(expiry){
  const sqlite=new DatabaseSync(":memory:");sqlite.exec(schema);
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(A,A);
  sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(A);
  sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,'v1','public')")
    .run(A,new Date(expiry).toISOString(),await sealWhoopToken("synthetic-access-old",{userId:A,purpose:"access",key}),await sealWhoopToken("synthetic-refresh-old",{userId:A,purpose:"refresh",key}));
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
async function capturing(fn){
  const lines=[];const orig=console.log;console.log=(...a)=>lines.push(a.join(" "));
  try{await fn();}finally{console.log=orig;}
  return lines;
}
const ok=()=>new Response(JSON.stringify({access_token:"synthetic-access-new",refresh_token:"synthetic-refresh-new",expires_in:3600,scope:"read:profile"}),{status:200,headers:{"content-type":"application/json"}});

test("successful refresh logs exactly one sanitized whoop_refresh ok line",async()=>{
  const d=await fixture(now-1000);try{
    const lines=await capturing(()=>whoopAccessToken(d,A,env,{now:()=>now,fetcher:async()=>ok()}));
    const refresh=lines.filter(l=>l.includes('"whoop_refresh"'));
    assert.deepEqual(refresh.map(l=>JSON.parse(l)),[{event:"whoop_refresh",outcome:"ok",rotated:true}]);
    assert.doesNotMatch(lines.join("\n"),new RegExp(`${A}|synthetic-|read:profile|Bearer`));
  }finally{d.close();}
});

test("a valid-token read logs no refresh line and makes no token call",async()=>{
  const d=await fixture(now+3600000);try{
    let calls=0;
    const lines=await capturing(()=>whoopAccessToken(d,A,env,{now:()=>now,fetcher:async()=>{calls++;return ok();}}));
    assert.equal(calls,0);
    assert.equal(lines.filter(l=>l.includes('"whoop_refresh"')).length,0);
  }finally{d.close();}
});

test("a rejected refresh logs no ok line",async()=>{
  const d=await fixture(now-1000);try{
    const lines=await capturing(()=>assert.rejects(whoopAccessToken(d,A,env,{now:()=>now,fetcher:async()=>new Response("{}",{status:400})}),/rejected/));
    assert.equal(lines.filter(l=>l.includes('"outcome":"ok"')).length,0);
  }finally{d.close();}
});
