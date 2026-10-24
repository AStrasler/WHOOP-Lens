// Synthetic fixtures shared by the post-deploy audit tests. No real member data.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sealWhoopToken } from "../src/token-crypto.mjs";
import { callWhoop } from "../src/whoop-api.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { d1Database } from "./d1-sqlite.mjs";

export const key=randomBytes(32).toString("base64url");
export const ENDPOINTS={get_recovery:["recovery","recovery"],get_sleep:["sleep","activity/sleep"],get_workouts:["workouts","activity/workout"],get_cycles:["cycles","cycle"]};
const PATH_TO_RESOURCE=Object.fromEntries(Object.values(ENDPOINTS).map(([r,p])=>["/developer/v2/"+p,r]));
export const TOTAL=230;
export const baseEnv={MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true",
  WHOOP_OAUTH_ENABLED:"true",WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",
  WHOOP_CLIENT_SECRET:"synthetic-secret-123"};
export const member=i=>`${String(i).padStart(8,"0")}-0000-4000-8000-${String(i).padStart(12,"0")}`;
const migrationFiles=["0001_initial.sql","0002_enforce_seat_limits.sql","0008_whoop_credential_revocations.sql","0011_ai_weekly_digest.sql"];
export async function fixture(users){
  const sqlite=new DatabaseSync(":memory:");
  for(const f of migrationFiles)sqlite.exec(readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
  for(const [id,role] of users){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
    await connect(sqlite,id,role,"access-"+id);
  }
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
export async function connect(sqlite,id,role,accessToken){
  const access=await sealWhoopToken(accessToken,{userId:id,purpose:"access",key});
  const refresh=await sealWhoopToken("refresh-"+id,{userId:id,purpose:"refresh",key});
  sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_access_token=excluded.encrypted_access_token,expires_at=excluded.expires_at")
    .run(id,new Date(Date.now()+86400000).toISOString(),access,refresh,"v1",role);
}
// Fake WHOOP keyed by bearer. Bearer "access-<id>" and "access2-<id>" are two
// different WHOOP accounts; the raw WHOOP cursor is an offset only (WHOOP's own
// cursor does not name the account), so a stale cursor is honoured by WHOOP.
export function fakeWhoop({fail=()=>null,delay=0}={}){
  const calls=[];
  const fetch=async(rawUrl,options)=>{
    const url=new URL(rawUrl);
    const bearer=options.headers.authorization.replace(/^Bearer /,"");
    const resource=PATH_TO_RESOURCE[url.pathname];
    assert.ok(resource,"unknown path "+url.pathname);
    const limit=Number(url.searchParams.get("limit"));
    const raw=url.searchParams.get("nextToken");
    const offset=raw==null?0:Number(atob(raw).split(":")[1]);
    calls.push({bearer,resource,offset,limit});
    if(delay)await new Promise(r=>setTimeout(r,Math.random()*delay));
    // fail may be async (for example, to finish a simulated reconnect first).
    const forced=await fail({bearer,resource,offset,call:calls.length});
    if(forced)return forced;
    const records=[];
    for(let i=offset;i<Math.min(offset+limit,TOTAL);i++)records.push({id:`${bearer}|${resource}|${i}`,account:bearer});
    const next=offset+limit<TOTAL?btoa(`${resource}:${offset+limit}`):null;
    return new Response(JSON.stringify({records,next_token:next}),{status:200,headers:{"content-type":"application/json"}});
  };
  return {calls,fetch};
}
export function setup(whoop,extraEnv={}){
  const route=createStagingRouter({
    verifyIdentity:async(request)=>request.headers.get("x-synthetic-member"),
    whoopRequest:(db,userId,resource,env,opts)=>callWhoop(db,userId,resource,env,opts,{fetcher:whoop.fetch})
  });
  return async(db,who,name,args,env={})=>{
    const message={jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}};
    const response=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{
      "content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic",
      "x-synthetic-member":who,"mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name
    },body:JSON.stringify(message)}),{...baseEnv,...extraEnv,...env,DB:db});
    return {status:response.status,body:await response.json()};
  };
}
export const content=r=>r.body.result?.structuredContent;
