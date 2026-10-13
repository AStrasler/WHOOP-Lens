import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createStagingRouter } from "../src/router.mjs";
import { AccessDenied, verifySupabaseSession } from "../src/identity.mjs";
import { activeMembership, connectionStatus, readHistory } from "../src/storage.mjs";
import { d1Prepare, d1Database } from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const schema=readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8");
const cfg=readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8");
const worker=readFileSync(new URL("../src/index.js",import.meta.url),"utf8");

function createDb() {
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(schema);
  // This adapter uses an actual in-memory SQLite engine with D1-style methods.
  return {
    sqlite,
    ...d1Database(sqlite),
    close(){sqlite.close();}
  };
}
function seed(db,{memberA=true,connectedA=true}={}){
  const sql=db.sqlite;
  for(const [id,provider,subject] of [
    [A,"supabase",A],[B,"supabase",B],[C,"other",C]
  ]) sql.prepare("INSERT INTO identity_links (user_id, identity_provider, provider_subject) VALUES (?,?,?)").run(id,provider,subject);
  if(memberA) sql.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(A);
  sql.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,0)").run(B);
  sql.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(C);
  if(connectedA) sql.prepare(
    "INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)"
  ).run(A,"2027-01-01","supersecretaccess","supersecretrefresh","v1","developer");
  for(const [id,whoopId,score] of [[A,"a-record",75],[B,"b-record",12]]) {
    sql.prepare("INSERT INTO whoop_recovery(user_id,whoop_id,date,score,raw_json) VALUES(?,?,?,?,?)")
      .run(id,whoopId,"2026-10-10",score,'{"synthetic":true}');
    sql.prepare("INSERT INTO whoop_sleep(user_id,whoop_id,start_time,raw_json) VALUES(?,?,?,?)")
      .run(id,whoopId,"2026-10-10T04:00:00Z",'{"synthetic":true}');
  }
}
const fakeIdentity = id => async () => id;
function request(path,token="some-super-long-test-token") {
  return new Request("https://migration.invalid"+path,{headers:{Authorization:"Bearer "+token}});
}
function enabled(db){return {DB:db,MIGRATION_API_ENABLED:"true"};}

test("D1 migration executes on genuine SQLite with all expected tables",()=>{
  const d=createDb();
  try {
    const tables=d.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    for(const name of ["identity_links","whoop_connections","whoop_members","whoop_recovery",
      "whoop_sleep","whoop_oauth_states","samsung_health_records","whoop_waitlist",
      "health_connect_records","medical_context"])
      assert.ok(tables.includes(name),name);
    assert.equal(d.sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys,1);
  }finally{d.close();}
});

test("Worker explicitly disabled; no identity or DB work can occur",async()=>{
  const d=createDb();
  try{
    let invocations=0;
    const route=createStagingRouter({verifyIdentity:async()=>{invocations++;throw Error("unexpected");}});
    const r=await route(request("/v1/recovery"),{DB:d,MIGRATION_API_ENABLED:"false"});
    assert.equal(r.status,503);
    assert.equal(invocations,0);
    assert.match(cfg,/"name"\s*:\s*"whoop-lens"/);
    assert.match(cfg,/Future custom domain: whooplens\.tech/);
    assert.doesNotMatch(cfg,/"routes?"\s*:/);
    assert.doesNotMatch(cfg,/"custom_domains"\s*:/);
    assert.match(cfg,/"workers_dev"\s*:\s*false/);
    assert.match(cfg,/"preview_urls"\s*:\s*false/);
    assert.match(cfg,/"MIGRATION_API_ENABLED"\s*:\s*"false"/);
    assert.match(worker,/createStagingRouter/);
  }finally{d.close();}
});

test("Auth bridge verifies through the official Supabase Auth endpoint, not untrusted JWT decoding",async()=>{
  const input=request("/v1/status");
  let calls=0;
  const user=await verifySupabaseSession(input,{SUPABASE_PUBLIC_KEY:"safe-publishable-test"},async (url,options)=>{
    calls++;
    assert.equal(url,"https://evoiwauqplbcecumiwqn.supabase.co/auth/v1/user");
    assert.match(options.headers.Authorization,/^Bearer /);
    assert.equal(options.headers.apikey,"safe-publishable-test");
    assert.equal(options.redirect,"manual");
    return new Response(JSON.stringify({id:A,email:"do-not-return@example.com"}),{status:200});
  });
  assert.equal(user,A);assert.equal(calls,1);
  await assert.rejects(
    verifySupabaseSession(request("/v1/status","invalid token"),{SUPABASE_PUBLIC_KEY:"test"},()=>{throw Error("no");}),
    AccessDenied
  );
  await assert.rejects(
    verifySupabaseSession(input,{SUPABASE_PUBLIC_KEY:"test"},async()=>new Response("{}",{status:401})),
    AccessDenied
  );
  await assert.rejects(
    verifySupabaseSession(input,{SUPABASE_PUBLIC_KEY:"test"},async()=>new Response("{}",{status:502})),
    /Identity provider unavailable/
  );
});

test("Missing and disabled members denied; no implicit approval for connected accounts",async()=>{
  const d=createDb();
  try{
    seed(d,{memberA:false});
    assert.equal(await activeMembership(d,A),false);
    assert.equal(await activeMembership(d,B),false);
    assert.equal(await activeMembership(d,C),false);
    assert.deepEqual(await connectionStatus(d,A),{connected:true});
    const route=createStagingRouter({verifyIdentity:fakeIdentity(A)});
    const result=await route(request("/v1/status"),enabled(d));
    assert.equal(result.status,403);
    assert.doesNotMatch(await result.text(),/supersecret|a-record/);
  }finally{d.close();}
});

test("Active user reads only owner records; no access to tokens or other users",async()=>{
  const d=createDb();
  try{
    seed(d);
    assert.equal(await activeMembership(d,A),true);
    assert.equal(await activeMembership(d,B),false);
    const route=createStagingRouter({verifyIdentity:fakeIdentity(A)});
    const a=await route(request("/v1/recovery?limit=25&user_id="+B),enabled(d));
    assert.equal(a.status,200);
    const body=await a.json();
    assert.equal(body.records.length,1);
    assert.equal(body.records[0].whoop_id,"a-record");
    assert.doesNotMatch(JSON.stringify(body),/b-record|supersecretaccess|supersecretrefresh/);
    const sleep=await route(request("/v1/sleep"),enabled(d));
    assert.equal(sleep.status,200);
    assert.equal((await sleep.json()).records[0].whoop_id,"a-record");
    const status=await route(request("/v1/status"),enabled(d));
    assert.deepEqual(await status.json(),{connected:true,source:"cloudflare-staging"});
    assert.deepEqual((await readHistory(d,B,"recovery",10))[0].whoop_id,"b-record");
  }finally{d.close();}
});

test("Invalid input, writes and unauthenticated requests fail closed",async()=>{
  const d=createDb();
  try{
    seed(d);
    const yes=createStagingRouter({verifyIdentity:fakeIdentity(A)});
    const no=createStagingRouter({verifyIdentity:async()=>{throw new AccessDenied(401);}});
    const disabled=createStagingRouter({verifyIdentity:fakeIdentity(B)});
    assert.equal((await no(request("/v1/status"),enabled(d))).status,401);
    assert.equal((await disabled(request("/v1/sleep"),enabled(d))).status,403);
    assert.equal((await yes(new Request("https://migration.invalid/v1/recovery",{method:"POST"}),enabled(d))).status,405);
    assert.equal((await yes(request("/v1/recovery?limit=100"),enabled(d))).status,400);
    assert.equal((await yes(request("/v1/anything"),enabled(d))).status,404);
    assert.equal((await yes(request("/v1/recovery"),{MIGRATION_API_ENABLED:"true"})).status,503);
    await assert.rejects(readHistory(d,A,"whoop_connections",10),/Unsupported history/);
    await assert.rejects(readHistory(d,A,"recovery",100),/range/);
  }finally{d.close();}
});
