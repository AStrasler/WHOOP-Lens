// WHOOP Lens seat cap (seat-limit.mjs). Synthetic members only; no real data.
import assert from "node:assert/strict";
import test from "node:test";
import {fixture,member,baseEnv,connect,fakeWhoop,setup,content} from "./audit-fixtures.mjs";
import {createWhoopAuthorization,acceptWhoopCallback} from "../src/whoop-oauth.mjs";
import {createStagingRouter} from "../src/router.mjs";
import {seatLimit,SeatsFull,DEFAULT_SEAT_LIMIT,SEAT_LIMIT_CEILING} from "../src/seat-limit.mjs";
import {memberLimits} from "../src/member-rate-limit.mjs";

const OWNER=member(31),M1=member(32),M2=member(33),M3=member(34),M4=member(35);
const env0={...baseEnv,WHOOP_REDIRECT_URI:"https://whooplens.tech/api/whoop/callback"};
const quietly=async fn=>{const log=console.log;console.log=()=>{};try{return await fn();}finally{console.log=log;}};
function admit(d,id){
  d.sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
  d.sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
}
async function authorize(d,id,env){
  const start=await createWhoopAuthorization(d,id,env);
  const url=new URL("https://whooplens.tech/api/whoop/callback");
  url.searchParams.set("state",new URL(start.authorization_url).searchParams.get("state"));url.searchParams.set("code","synthetic-code-123");
  return url;
}
const exchange=id=>async()=>new Response(JSON.stringify({access_token:"access-"+id+"-"+Math.random(),refresh_token:"r-"+id,expires_in:3600,scope:"offline"}),{status:200});
const callback=(d,url,id,env)=>acceptWhoopCallback(d,url,env,{fetcher:exchange(id)});
const connectVia=async(d,id,env=env0)=>callback(d,await authorize(d,id,env),id,env);
const count=d=>d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_connections").get().n;

test("seat cap config: default 3, whole numbers 1-10, invalid uses the default, never a larger cap",async()=>{
  assert.equal(DEFAULT_SEAT_LIMIT,3);assert.equal(SEAT_LIMIT_CEILING,10);
  assert.equal(seatLimit({}),3);assert.equal(seatLimit({WHOOP_LENS_SEAT_LIMIT:""}),3);
  assert.equal(seatLimit({WHOOP_LENS_SEAT_LIMIT:"4"}),4);assert.equal(seatLimit({WHOOP_LENS_SEAT_LIMIT:" 1 "}),1);
  assert.equal(seatLimit({WHOOP_LENS_SEAT_LIMIT:"25"}),10,"clamped to the database ceiling (9 public + 1 developer)");
  await quietly(()=>{for(const bad of ["0","-1","3.5","ten","1e3","0x5"])assert.equal(seatLimit({WHOOP_LENS_SEAT_LIMIT:bad}),3,bad);});
});

test("seat cap: the owner counts; a 4th member is refused before WHOOP and at the callback; reconnects always work",async()=>{
  const d=await fixture([]);
  try{
    for(const id of [OWNER,M1,M2,M3])admit(d,id);
    // The owner's seat (public role in production today) is one of the three.
    for(const id of [OWNER,M1,M2])assert.equal((await connectVia(d,id)).connected,true);
    assert.equal(count(d),3);
    // A 4th approved member is refused at authorize: no WHOOP redirect, no state.
    const states=d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_oauth_states").get().n;
    await assert.rejects(createWhoopAuthorization(d,M3,env0),e=>e instanceof SeatsFull&&e.limit===3&&/All 3 WHOOP Lens seats are in use/.test(e.message));
    assert.equal(d.sqlite.prepare("SELECT COUNT(*) n FROM whoop_oauth_states").get().n,states);
    // Existing members reconnect (overwrite) while seats are full.
    for(const id of [OWNER,M1,M2])assert.equal((await connectVia(d,id)).connected,true);
    assert.equal(count(d),3);
    // An authorization started before the seats filled is refused at the callback.
    const d2=await fixture([]);
    try{
      for(const id of [OWNER,M1,M2,M3])admit(d2,id);
      await connectVia(d2,OWNER);await connectVia(d2,M1);
      const late=await authorize(d2,M3,env0);
      await connectVia(d2,M2);
      await assert.rejects(callback(d2,late,M3,env0),SeatsFull);
      assert.equal(count(d2),3);
      assert.equal(d2.sqlite.prepare("SELECT COUNT(*) n FROM whoop_connections WHERE user_id=?").get(M3).n,0);
    }finally{d2.close();}
  }finally{d.close();}
});

test("seat cap: concurrent callbacks for the last seat admit exactly one",async()=>{
  const d=await fixture([]);
  try{
    for(const id of [OWNER,M1,M2,M3,M4])admit(d,id);
    await connectVia(d,OWNER);await connectVia(d,M1);
    const urls=await Promise.all([M2,M3,M4].map(id=>authorize(d,id,env0)));
    const results=await Promise.allSettled([M2,M3,M4].map((id,i)=>callback(d,urls[i],id,env0)));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.ok(results.filter(r=>r.status==="rejected").every(r=>r.reason instanceof SeatsFull));
    assert.equal(count(d),3);
  }finally{d.close();}
});

test("seat cap: disconnect frees a seat; a configured cap of 4 admits one more; existing over-cap rows keep working",async()=>{
  const d=await fixture([]);
  try{
    for(const id of [OWNER,M1,M2,M3,M4])admit(d,id);
    for(const id of [OWNER,M1,M2])await connectVia(d,id);
    const w=fakeWhoop(),call=setup(w);
    assert.equal(content(await call(d,M2,"disconnect_whoop",{})).disconnected,true);
    // OAuth states have second precision; one started in the disconnect's second is refused as revoked.
    await new Promise(r=>setTimeout(r,1100));
    assert.equal((await connectVia(d,M3)).connected,true,"freed seat reused");
    await assert.rejects(connectVia(d,M2),SeatsFull,"the member who left needs a free seat again");
    const four={...env0,WHOOP_LENS_SEAT_LIMIT:"4"};
    assert.equal((await connectVia(d,M2,four)).connected,true);
    await assert.rejects(connectVia(d,M4,four),SeatsFull);
    // Lowering the cap below the current count blocks only new connections.
    for(const id of [OWNER,M1,M2,M3])assert.equal((await connectVia(d,id)).connected,true);
    assert.equal(count(d),4);
    // Reads are unaffected by the cap.
    assert.equal(content(await call(d,M3,"get_cycles",{limit:5})).records.length,5);
  }finally{d.close();}
});

test("seat cap: MCP connect_whoop and REST /v1/whoop/connect say the seats are full (409); no WHOOP URL",async()=>{
  const d=await fixture([]);
  try{
    for(const id of [OWNER,M1,M2,M3])admit(d,id);
    for(const id of [OWNER,M1,M2])await connectVia(d,id);
    const route=createStagingRouter({verifyIdentity:async r=>r.headers.get("x-synthetic-member")});
    const env={...env0,DB:d};
    const mcp=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic",
      "x-synthetic-member":M3,"mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":"connect_whoop"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"connect_whoop",arguments:{}}})}),env);
    const body=await mcp.json();
    assert.equal(body.result.isError,true);
    assert.match(body.result.content[0].text,/All 3 WHOOP Lens seats are in use\. New seats are granted only by the owner after a seat request\./);
    assert.doesNotMatch(JSON.stringify(body),/oauth2\/auth/);
    const rest=await route(new Request("https://staging.invalid/v1/whoop/connect",{headers:{"x-synthetic-member":M3,authorization:"Bearer synthetic"}}),env);
    assert.equal(rest.status,409);
    assert.deepEqual(await rest.json(),{error:"All 3 WHOOP Lens seats are in use. New seats are granted only by the owner after a seat request.",seat_limit:3});
  }finally{d.close();}
});

test("seat cap and rate limits are independent controls",()=>{
  const limits=env=>JSON.stringify(memberLimits(env));
  const base=limits({});
  for(const v of ["1","3","10"])assert.equal(limits({WHOOP_LENS_SEAT_LIMIT:v}),base,"seat cap never changes request limits");
  assert.deepEqual(memberLimits({}),{public:{perMinute:25,perDay:1000},developer:{perMinute:25,perDay:1000}},"owner included");
  for(const v of ["5","50","2000"])
    assert.equal(seatLimit({WHOOP_MEMBER_LIMIT_PER_MINUTE:v,WHOOP_MEMBER_LIMIT_PER_DAY:v,WHOOP_DEVELOPER_LIMIT_PER_MINUTE:v,WHOOP_DEVELOPER_LIMIT_PER_DAY:v}),3,"request limits never change the seat cap");
});
