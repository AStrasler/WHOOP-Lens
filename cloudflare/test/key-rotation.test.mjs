import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sealWhoopToken, sealWithKeyring, openWithKeyring, tokenKeyring, envelopeKeyId } from "../src/token-crypto.mjs";
import { migrateAllTokens, tokenKeyCounts, resetMigrationThrottle } from "../src/token-migration.mjs";
import { whoopAccessToken } from "../src/whoop-api.mjs";
import { getSecret, resolveSecrets } from "../src/secrets.mjs";
import { d1Database } from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD=randomBytes(32).toString("base64url");
const NEXT=randomBytes(32).toString("base64url");
const schema=readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8");
const now=Date.parse("2026-10-13T12:00:00Z");

function capture(){
  const lines=[],orig=console.log;
  console.log=(...a)=>lines.push(a.join(" "));
  return {lines,restore(){console.log=orig;}};
}
function fixture(){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(schema);
  for(const id of [A,B,C]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
  }
  return {sqlite,close(){sqlite.close();},...d1Database(sqlite)};
}
async function insert(d,id,keys){
  const access=await sealWithKeyring("acc-"+id,{userId:id,purpose:"access",keys});
  const refresh=await sealWithKeyring("ref-"+id,{userId:id,purpose:"refresh",keys});
  d.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
    .run(id,new Date(now+3600_000).toISOString(),access,refresh,"v1","public");
}
const row=(d,id)=>d.sqlite.prepare("SELECT * FROM whoop_connections WHERE user_id=?").get(id);
const noSecrets=(text)=>{
  for(const s of [OLD,NEXT,"acc-","ref-","store-only-client-secret-value"])assert.ok(!text.includes(s),"log leaked a value");
};

test("without NEXT, sealing is unchanged v1 with the old key",async()=>{
  const keys=tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD});
  const env=await sealWithKeyring("t",{userId:A,purpose:"access",keys});
  assert.equal(envelopeKeyId(env),"legacy");
  assert.deepEqual(await openWithKeyring(env,{userId:A,purpose:"access",keys}),{token:"t",key:"k1"});
});

test("with NEXT, new envelopes carry k2 and legacy envelopes still open via the old key",async()=>{
  const keys=tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD,WHOOP_TOKEN_AES256_KEY_NEXT:NEXT});
  const sealed=await sealWithKeyring("t",{userId:A,purpose:"access",keys});
  assert.match(sealed,/^v2\.k2\./);
  assert.equal((await openWithKeyring(sealed,{userId:A,purpose:"access",keys})).key,"k2");
  const legacy=await sealWhoopToken("old",{userId:A,purpose:"access",key:OLD});
  assert.deepEqual(await openWithKeyring(legacy,{userId:A,purpose:"access",keys}),{token:"old",key:"k1"});
  // k2 envelopes never fall back to k1.
  await assert.rejects(openWithKeyring(sealed,{userId:A,purpose:"access",keys:{...keys,k2:OLD}}));
});

test("batch migration re-encrypts mixed rows to k2, logs only counts, and is idempotent",async()=>{
  const d=fixture();const cap=capture();
  try{
    const oldKeys=tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD});
    const env={WHOOP_TOKEN_AES256_KEY:OLD,WHOOP_TOKEN_AES256_KEY_NEXT:NEXT};
    await insert(d,A,oldKeys);await insert(d,B,oldKeys);await insert(d,C,tokenKeyring(env));
    assert.deepEqual(await tokenKeyCounts(d),{total:3,on_k2:1,remaining:2});
    resetMigrationThrottle();
    const first=await migrateAllTokens(d,env,{now:()=>now});
    assert.equal(first.migrated,2);assert.equal(first.failed,0);assert.equal(first.remaining,0);
    const nextOnly=tokenKeyring({WHOOP_TOKEN_AES256_KEY_NEXT:NEXT});
    for(const id of [A,B,C]){
      const r=row(d,id);
      assert.match(r.encrypted_access_token,/^v2\.k2\./);
      assert.equal((await openWithKeyring(r.encrypted_access_token,{userId:id,purpose:"access",keys:nextOnly})).token,"acc-"+id);
      assert.equal((await openWithKeyring(r.encrypted_refresh_token,{userId:id,purpose:"refresh",keys:nextOnly})).token,"ref-"+id);
    }
    assert.equal((await migrateAllTokens(d,env,{now:()=>now+1})).skipped,"throttled");
    assert.equal((await migrateAllTokens(d,env,{force:true,now:()=>now})).migrated,0);
    assert.equal((await migrateAllTokens(d,{WHOOP_TOKEN_AES256_KEY:OLD},{force:true,now:()=>now})).skipped,"no_next_key");
  }finally{cap.restore();d.close();}
  noSecrets(cap.lines.join("\n"));
  assert.ok(cap.lines.some(l=>l.includes('"token_key_migration"')&&l.includes('"remaining":0')));
});

test("a row that fails to decrypt is counted and left untouched",async()=>{
  const d=fixture();const cap=capture();
  try{
    const env={WHOOP_TOKEN_AES256_KEY:OLD,WHOOP_TOKEN_AES256_KEY_NEXT:NEXT};
    await insert(d,A,tokenKeyring({WHOOP_TOKEN_AES256_KEY:randomBytes(32).toString("base64url")}));
    const before=row(d,A).encrypted_access_token;
    const out=await migrateAllTokens(d,env,{force:true,now:()=>now});
    assert.equal(out.failed,1);assert.equal(out.remaining,1);
    assert.equal(row(d,A).encrypted_access_token,before);
  }finally{cap.restore();d.close();}
  noSecrets(cap.lines.join("\n"));
});

test("a read lazily migrates the caller's legacy row",async()=>{
  const d=fixture();const cap=capture();
  try{
    await insert(d,A,tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD}));
    resetMigrationThrottle();
    const env={WHOOP_TOKEN_AES256_KEY:OLD,WHOOP_TOKEN_AES256_KEY_NEXT:NEXT};
    assert.equal(await whoopAccessToken(d,A,env,{now:()=>now}),"acc-"+A);
    assert.match(row(d,A).encrypted_access_token,/^v2\.k2\./);
    assert.match(row(d,A).encrypted_refresh_token,/^v2\.k2\./);
    assert.equal(row(d,A).encryption_key_version,"k2");
    assert.equal(await whoopAccessToken(d,A,{WHOOP_TOKEN_AES256_KEY_NEXT:NEXT},{now:()=>now}),"acc-"+A);
  }finally{cap.restore();d.close();}
  noSecrets(cap.lines.join("\n"));
});

test("getSecret uses the store only when the primary is missing or invalid",async()=>{
  const cap=capture();let gets=0;
  const store=value=>({async get(){gets++;return value;}});
  try{
    const secret="store-only-client-secret-value";
    assert.equal(await getSecret({BK_WHOOP_CLIENT_SECRET:store(secret)},"WHOOP_CLIENT_SECRET"),secret);
    assert.equal(await getSecret({WHOOP_CLIENT_SECRET:"[REDACTED]",BK_WHOOP_CLIENT_SECRET:store(secret)},"WHOOP_CLIENT_SECRET"),secret);
    assert.equal(await getSecret({WHOOP_TOKEN_AES256_KEY:"short",BK_WHOOP_TOKEN_AES256_KEY:store(OLD)},"WHOOP_TOKEN_AES256_KEY"),OLD);
    gets=0;
    assert.equal(await getSecret({WHOOP_TOKEN_AES256_KEY:OLD,BK_WHOOP_TOKEN_AES256_KEY:store(NEXT)},"WHOOP_TOKEN_AES256_KEY"),OLD);
    assert.equal(gets,0);
    assert.equal(await getSecret({BK_WHOOP_TOKEN_AES256_KEY:store("bad value")},"WHOOP_TOKEN_AES256_KEY"),null);
    assert.equal(await getSecret({BK_WHOOP_CLIENT_ID:{async get(){throw Error("x");}}},"WHOOP_CLIENT_ID"),null);
    const resolved=await resolveSecrets({WHOOP_TOKEN_AES256_KEY:"",BK_WHOOP_TOKEN_AES256_KEY:store(OLD),WHOOP_CLIENT_ID:"keep-me-as-is"});
    assert.equal(resolved.WHOOP_TOKEN_AES256_KEY,OLD);
    assert.equal(resolved.WHOOP_CLIENT_ID,"keep-me-as-is");
  }finally{cap.restore();}
  const text=cap.lines.join("\n");
  noSecrets(text);
  assert.ok(cap.lines.some(l=>l.includes('"source":"store"')&&l.includes('"reason":"missing"')));
});

test("a decrypt failure with a valid primary key never consults the store",async()=>{
  const d=fixture();let gets=0;const cap=capture();
  try{
    await insert(d,A,tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD}));
    const raw={WHOOP_TOKEN_AES256_KEY:randomBytes(32).toString("base64url"),
      BK_WHOOP_TOKEN_AES256_KEY:{async get(){gets++;return OLD;}}};
    const env=await resolveSecrets(raw);
    await assert.rejects(whoopAccessToken(d,A,env,{now:()=>now}));
    assert.equal(gets,0);
  }finally{cap.restore();d.close();}
});

test("a re-encryption landing mid-refresh does not drop the rotated refresh token",async()=>{
  const d=fixture();const cap=capture();
  try{
    const oldKeys=tokenKeyring({WHOOP_TOKEN_AES256_KEY:OLD});
    await insert(d,A,oldKeys);
    d.sqlite.prepare("UPDATE whoop_connections SET expires_at=? WHERE user_id=?").run(new Date(now-1000).toISOString(),A);
    const env={WHOOP_TOKEN_AES256_KEY:OLD,WHOOP_TOKEN_AES256_KEY_NEXT:NEXT,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret"};
    const keys=tokenKeyring(env);
    // The batch pass skips this row (near expiry), even when forced.
    resetMigrationThrottle();
    assert.equal((await migrateAllTokens(d,env,{now:()=>now,force:true})).migrated,0);
    const token=await whoopAccessToken(d,A,env,{now:()=>now,fetcher:async()=>{
      // Simulate a re-encryption racing in while WHOOP answers.
      const r=row(d,A);
      const acc=await sealWithKeyring("acc-"+A,{userId:A,purpose:"access",keys});
      const ref=await sealWithKeyring("ref-"+A,{userId:A,purpose:"refresh",keys});
      d.sqlite.prepare("UPDATE whoop_connections SET encrypted_access_token=?,encrypted_refresh_token=? WHERE user_id=? AND encrypted_refresh_token=?")
        .run(acc,ref,A,r.encrypted_refresh_token);
      return new Response(JSON.stringify({access_token:"rotated-access",refresh_token:"rotated-refresh",expires_in:3600}),{status:200});
    }});
    assert.equal(token,"rotated-access");
    const r=row(d,A);
    assert.equal((await openWithKeyring(r.encrypted_refresh_token,{userId:A,purpose:"refresh",keys})).token,"rotated-refresh");
    assert.equal(r.encryption_key_version,"k2");
  }finally{cap.restore();d.close();}
});
