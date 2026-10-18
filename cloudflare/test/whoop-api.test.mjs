import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sealWhoopToken, openWhoopToken } from "../src/token-crypto.mjs";
import { callWhoop, whoopAccessToken } from "../src/whoop-api.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { d1Prepare, d1Database } from "./d1-sqlite.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now=Date.parse("2026-10-11T12:00:00Z");
const key=randomBytes(32).toString("base64url");
const schema=readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8");
const env={WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret"};

function dbFixture() {
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(schema);
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
  }
  return {
    sqlite,close(){sqlite.close();},
    ...d1Database(sqlite),
  };
}
async function connect(db,id,{expiry=now+3600000,role="public"}={}){
  const access=await sealWhoopToken("test-access-"+id,{userId:id,purpose:"access",key});
  const refresh=await sealWhoopToken("test-refresh-"+id,{userId:id,purpose:"refresh",key});
  db.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
    .run(id,new Date(expiry).toISOString(),access,refresh,"v1",role);
}
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
const identity=id=>async()=>id;
const apiReq=(path)=>new Request("https://staging.invalid"+path,{headers:{Authorization:"Bearer synthetic-token"}});
test("encrypted D1 connection produces only its authenticated WHOOP user profile",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A);await connect(d,B);
    const calls=[];
    const data=await callWhoop(d,A,"profile",env,{},{
      now:()=>now,fetcher:async(url,options)=>{
        calls.push({url,authorization:options.headers.authorization});
        return response({user_id:42,first_name:"Synthetic"});
      }
    });
    assert.equal(data.first_name,"Synthetic");
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,"https://api.prod.whoop.com/developer/v2/user/profile/basic");
    assert.equal(calls[0].authorization,"Bearer test-access-"+A);
    assert.doesNotMatch(JSON.stringify(data),/refresh/);
    await assert.rejects(callWhoop(d,A,"arbitrary-url",env),/Unsupported/);
    await assert.rejects(callWhoop(d,A,"recovery",env,{next_token:"../../admin"}),/Invalid WHOOP cursor/);
  }finally{d.close();}
});
test("six WHOOP endpoints honor fixed resource paths and bounded pagination",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A);
    const expected={
      profile:"user/profile/basic",measurements:"user/measurement/body",
      recovery:"recovery",sleep:"activity/sleep",workouts:"activity/workout",cycles:"cycle"
    };
    for(const [name,path] of Object.entries(expected)){
      let got=null;
      const out=await callWhoop(d,A,name,env,name==="recovery"?{limit:25,next_token:"abc.next-1"}:{},{
        now:()=>now,fetcher:async(url,options)=>{got={url,options};return response({records:[]});}
      });
      assert.deepEqual(out,{records:[]});
      assert.equal(new URL(got.url).pathname,"/developer/v2/"+path);
      assert.equal(new URL(got.url).searchParams.has("limit"),name==="recovery"||["sleep","workouts","cycles"].includes(name));
      if(name==="recovery"){
        assert.equal(new URL(got.url).searchParams.get("limit"),"25");
        assert.equal(new URL(got.url).searchParams.get("nextToken"),"abc.next-1");
      }
      assert.equal(got.options.method,"GET");
      assert.equal(got.options.redirect,"manual");
    }
  }finally{d.close();}
});
test("optional WHOOP start/end window is sent only when given, validated, and 429 keeps its status",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A);
    let got=null;
    const fetcher=async(url)=>{got=new URL(url);return response({records:[]});};
    await callWhoop(d,A,"recovery",env,{limit:25},{now:()=>now,fetcher});
    assert.equal(got.searchParams.has("start"),false);assert.equal(got.searchParams.has("end"),false);
    await callWhoop(d,A,"recovery",env,{limit:25,start:"2026-08-01T00:00:00.000Z",end:"2026-09-02T00:00:00.000Z"},{now:()=>now,fetcher});
    assert.equal(got.searchParams.get("start"),"2026-08-01T00:00:00.000Z");
    assert.equal(got.searchParams.get("end"),"2026-09-02T00:00:00.000Z");
    await assert.rejects(callWhoop(d,A,"recovery",env,{start:"yesterday"},{now:()=>now,fetcher}),/Invalid WHOOP time window/);
    await assert.rejects(callWhoop(d,A,"recovery",env,{end:"2026-09-02T00:00:00Z&x=1"},{now:()=>now,fetcher}),/Invalid WHOOP time window/);
    await assert.rejects(callWhoop(d,A,"recovery",env,{},{now:()=>now,fetcher:async()=>new Response("",{status:429})}),
      e=>e.message==="WHOOP API request failed"&&e.status===429);
  }finally{d.close();}
});
test("expired tokens rotate securely via fixed WHOOP token endpoint; old tokens replaced",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A,{expiry:now-1000});
    const requests=[];
    const value=await whoopAccessToken(d,A,env,{
      now:()=>now,fetcher:async(url,opts)=>{
        requests.push({url,opts});
        return response({
          access_token:"synthetic-access-rotated",
          refresh_token:"synthetic-refresh-rotated",expires_in:3600,scope:"read:profile"
        });
      }
    });
    assert.equal(value,"synthetic-access-rotated");
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,"https://api.prod.whoop.com/oauth/oauth2/token");
    assert.equal(requests[0].opts.redirect,"manual");
    assert.equal(requests[0].opts.body.get("grant_type"),"refresh_token");
    assert.equal(requests[0].opts.body.get("refresh_token"),"test-refresh-"+A);
    const row=d.sqlite.prepare("SELECT * FROM whoop_connections WHERE user_id=?").get(A);
    assert.doesNotMatch(JSON.stringify(row),/synthetic-access-rotated|synthetic-refresh-rotated/);
    assert.equal(await openWhoopToken(row.encrypted_access_token,{userId:A,purpose:"access",key}),"synthetic-access-rotated");
    assert.equal(await openWhoopToken(row.encrypted_refresh_token,{userId:A,purpose:"refresh",key}),"synthetic-refresh-rotated");
    assert.equal(row.scope,"read:profile");
    assert.equal(row.expires_at,new Date(now+3600000).toISOString());
  }finally{d.close();}
});
test("missing membership, missing connection and stale writes fail without network calls",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A,{expiry:now-1});
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(A);
    let calls=0;
    const fetcher=async()=>{calls++;throw Error("should not call");};
    await assert.rejects(whoopAccessToken(d,A,env,{now:()=>now,fetcher}),/Membership required/);
    assert.equal(calls,0);
    d.sqlite.prepare("UPDATE whoop_members SET active=1 WHERE user_id=?").run(A);
    await assert.rejects(whoopAccessToken(d,B,env,{now:()=>now,fetcher}),/WHOOP connection required/);
    assert.equal(calls,0);
    const raced={
      prepare(sql){
        const op=d.prepare(sql);
        if(!sql.startsWith("UPDATE whoop_connections"))return op;
        let values;
        return {bind(...x){values=x;return this;},async run(){return {success:true,meta:{changes:0}};}};
      }
    };
    await assert.rejects(whoopAccessToken(raced,A,env,{now:()=>now,
      fetcher:async()=>response({access_token:"new",expires_in:3600})}),/raced or failed/);
  }finally{d.close();}
});
test("WHOOP routes are disabled separately, bounded and read-only even when staging API enabled",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A);
    let count=0,category;
    const router=createStagingRouter({
      verifyIdentity:identity(A),
      whoopRequest:async(db,userId,name,env,opts)=>{
        count++;category=name;assert.equal(userId,A);
        assert.equal(opts.limit,25);
        return {records:[{sample:42}],next_token:null};
      }
    });
    const base={DB:d,MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"false"};
    const denied=await router(apiReq("/v1/whoop/recovery?limit=25"),base);
    assert.equal(denied.status,503);assert.equal(count,0);
    const enabled={...base,WHOOP_READS_ENABLED:"true"};
    const allowed=await router(apiReq("/v1/whoop/recovery?limit=25&user_id="+B),enabled);
    assert.equal(allowed.status,200);assert.equal(count,1);assert.equal(category,"recovery");
    assert.deepEqual((await allowed.json()).data,{records:[{sample:42}],next_token:null,complete:true});
    const malformed=await router(apiReq("/v1/whoop/recovery?limit=999"),enabled);
    assert.equal(malformed.status,400);
    const notAllowed=await router(new Request("https://staging.invalid/v1/whoop/recovery",{method:"POST"}),enabled);
    assert.equal(notAllowed.status,405);
    d.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(A);
    assert.equal((await router(apiReq("/v1/whoop/recovery?limit=25"),enabled)).status,403);
    assert.equal(count,1);
  }finally{d.close();}
});

test("WHOOP API redirects are never followed and cannot leak bearer tokens",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A);
    await assert.rejects(callWhoop(d,A,"profile",env,{}, {
      now:()=>now,fetcher:async (_url,options)=>{
        assert.equal(options.redirect,"manual");
        return new Response(null,{status:302,headers:{location:"https://attacker.invalid/redirect"}});
      }
    }),/WHOOP API request failed/);
  }finally{d.close();}
});
test("parallel expired-token requests share one rotation instead of failing",async()=>{
  const d=dbFixture();
  try{
    await connect(d,A,{expiry:now-1000});
    let uses=0,release;
    const gate=new Promise(r=>{release=r;});
    const fetcher=async(url,options)=>{
      assert.equal(url,"https://api.prod.whoop.com/oauth/oauth2/token");
      const token=new URLSearchParams(options.body).get("refresh_token");
      uses++;
      if(uses===1){await gate;return response({access_token:"rotated-access",refresh_token:"rotated-refresh",expires_in:3600});}
      // The second use of the same rotated-away refresh token is rejected by WHOOP.
      assert.equal(token,"test-refresh-"+A);
      return new Response("{}",{status:400});
    };
    const first=whoopAccessToken(d,A,env,{now:()=>now,fetcher});
    await new Promise(r=>setImmediate(r));
    const second=whoopAccessToken(d,A,env,{now:()=>now,fetcher,
      sleep:async()=>{release();await first;}});
    assert.equal(await first,"rotated-access");
    // Second request lost the race at WHOOP after the winner stored new tokens.
    assert.equal(await second,"rotated-access");
    // A genuine failure with nothing refreshed elsewhere still fails.
    const d2=dbFixture();try{
      await connect(d2,A,{expiry:now-1000});
      await assert.rejects(whoopAccessToken(d2,A,env,{now:()=>now,
        fetcher:async()=>new Response("{}",{status:400}),sleep:async()=>{}}),/refresh failed/);
    }finally{d2.close();}
  }finally{d.close();}
});
