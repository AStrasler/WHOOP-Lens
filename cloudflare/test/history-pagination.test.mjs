import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sealWhoopToken } from "../src/token-crypto.mjs";
import { callWhoop } from "../src/whoop-api.mjs";
import { createStagingRouter } from "../src/router.mjs";
import { sealCursor, openCursor, CursorError, SEQUENCE_MAX_PAGES, CURSOR_TTL_MS } from "../src/history-pagination.mjs";
import { d1Database } from "./d1-sqlite.mjs";

// Synthetic members only. A holds the developer seat, B a public seat.
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key=randomBytes(32).toString("base64url");
const nextKey=randomBytes(32).toString("base64url");
const migrations=["0001_initial.sql","0002_enforce_seat_limits.sql","0008_whoop_credential_revocations.sql"].map(f=>readFileSync(new URL("../migrations/"+f,import.meta.url),"utf8"));
const ENDPOINTS={get_recovery:["recovery","recovery"],get_sleep:["sleep","activity/sleep"],get_workouts:["workouts","activity/workout"],get_cycles:["cycles","cycle"]};
const PATH_TO_RESOURCE=Object.fromEntries(Object.values(ENDPOINTS).map(([r,p])=>["/developer/v2/"+p,r]));
const TOTAL=230; // more than two full auto_page calls (100 records each)
const baseEnv={MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true",
  WHOOP_TOKEN_AES256_KEY:key,WHOOP_CLIENT_ID:"synthetic-client",WHOOP_CLIENT_SECRET:"synthetic-secret-123",
  WHOOP_LENS_DEVELOPER_USER_ID:A};

async function fixture({users=[[A,"developer"],[B,"public"]]}={}){
  const sqlite=new DatabaseSync(":memory:");
  for(const m of migrations)sqlite.exec(m);
  for(const [id,role] of users){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES(?,1)").run(id);
    const access=await sealWhoopToken("access-"+id,{userId:id,purpose:"access",key});
    const refresh=await sealWhoopToken("refresh-"+id,{userId:id,purpose:"refresh",key});
    sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?)")
      .run(id,new Date(Date.now()+86400000).toISOString(),access,refresh,"v1",role);
  }
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
// Fake WHOOP: per-member, per-endpoint record lists; nextToken is base64 with padding.
function fakeWhoop({fail=()=>null}={}){
  const calls=[];
  const owners={["Bearer access-"+A]:A,["Bearer access-"+B]:B,["Bearer access-"+C]:C};
  const fetch=async(rawUrl,options)=>{
    const url=new URL(rawUrl);
    const user=owners[options.headers.authorization];
    const resource=PATH_TO_RESOURCE[url.pathname];
    assert.ok(user,"unknown bearer");assert.ok(resource,"unknown path "+url.pathname);
    const limit=Number(url.searchParams.get("limit"));
    const raw=url.searchParams.get("nextToken");
    let offset=0;
    if(raw!=null){
      const [u,r,o]=atob(raw).split(":");
      // Record a foreign cursor reaching WHOOP so call-count checks catch it.
      if(u!==user||r!==resource){calls.push({user,resource,foreign:true});return new Response("{}",{status:400});}
      offset=Number(o);
    }
    calls.push({user,resource,offset,limit});
    const forced=fail({user,resource,offset,call:calls.length});
    if(forced)return forced;
    const records=[];
    for(let i=offset;i<Math.min(offset+limit,TOTAL);i++)records.push({id:`${user.slice(0,1)}-${resource}-${i}`,owner:user});
    const next=offset+limit<TOTAL?btoa(`${user}:${resource}:${offset+limit}`):null;
    return new Response(JSON.stringify({records,next_token:next}),{status:200,headers:{"content-type":"application/json"}});
  };
  return {calls,fetch};
}
function setup(whoop,extra={}){
  const route=createStagingRouter({
    verifyIdentity:async(request)=>request.headers.get("x-synthetic-member"),
    whoopRequest:(db,userId,resource,env,opts)=>callWhoop(db,userId,resource,env,opts,{fetcher:whoop.fetch})
  });
  return async(db,member,name,args,env={})=>{
    const message={jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}};
    const response=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{
      "content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer synthetic",
      "x-synthetic-member":member,"mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name
    },body:JSON.stringify(message)}),{...baseEnv,...extra,...env,DB:db});
    assert.equal(response.status,200);
    return response.json();
  };
}
const content=body=>body.result?.structuredContent;
const ids=records=>records.map(r=>r.id);
const expected=(user,resource,from=0,to=TOTAL)=>Array.from({length:to-from},(_,i)=>`${user.slice(0,1)}-${resource}-${from+i}`);

test("all four history endpoints continue past 100 records with auto_page and next_token together",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    for(const [name,[resource]] of Object.entries(ENDPOINTS)){
      const got=[];let cursor=null,rounds=0;
      do{
        // The failing client shape: auto_page stays true on continuation calls.
        const body=await call(db,B,name,cursor?{auto_page:true,next_token:cursor}:{auto_page:true});
        assert.equal(body.error,undefined,JSON.stringify(body.error));
        const out=content(body);
        assert.ok(out.records.length<=100);
        assert.ok(out.pages_fetched<=4);
        got.push(...ids(out.records));
        cursor=out.next_token;rounds++;
        assert.equal(out.complete,cursor===null);
        if(cursor)assert.match(cursor,/^wlc1\.k1\./);
      }while(cursor&&rounds<10);
      assert.equal(rounds,3);
      assert.deepEqual(got,expected(B,resource));
    }
    // WHOOP saw only B's bearer and never more than 25 per page.
    assert.ok(whoop.calls.every(c=>c.user===B&&c.limit===25));
    assert.equal(whoop.calls.length,4*10);
  }finally{db.close();}
});

test("manual paging with limit continues past 100 on all four endpoints and can switch modes",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    for(const [name,[resource]] of Object.entries(ENDPOINTS)){
      const got=[];let cursor=null,i=0;
      do{
        // Alternate manual and automatic continuation with the same cursor format.
        const args=i%2===0?{limit:25,next_token:cursor}:{auto_page:true,next_token:cursor};
        if(cursor===null)delete args.next_token;
        const out=content(await call(db,A,name,args));
        got.push(...ids(out.records));cursor=out.next_token;i++;
        // Both modes report completion the same way.
        assert.equal(out.complete,cursor===null);
      }while(cursor&&i<20);
      assert.deepEqual(got,expected(A,resource));
    }
  }finally{db.close();}
});

test("null and empty optional fields are accepted; identity fields and unknown keys are still rejected",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    const ok=content(await call(db,B,"get_sleep",{limit:null,auto_page:null,next_token:null}));
    assert.equal(ok.records.length,10);assert.equal(ok.complete,false);
    // Manual paging to the last page reports complete: true (Codex P2 on 657649a).
    let manual=ok;
    while(manual.next_token)manual=content(await call(db,B,"get_sleep",{limit:25,next_token:manual.next_token}));
    assert.equal(manual.complete,true);assert.equal(manual.next_token,null);
    const empty=content(await call(db,B,"get_sleep",{auto_page:true,next_token:""}));
    assert.equal(empty.records.length,100);
    const summaryNull=content(await call(db,B,"get_sleep",{summary:null},{AI_SUMMARY_ENABLED:"true"}));
    assert.equal(summaryNull.records.length,10);
    const before=whoop.calls.length;
    for(const args of [{user_id:A},{auto_page:true,member:A},{next_token:"x",owner_id:A},{limit:26},{limit:0},{auto_page:"true"},{next_token:42}]){
      const body=await call(db,B,"get_recovery",args);
      assert.equal(body.error?.code,-32602,JSON.stringify(args));
    }
    assert.equal(whoop.calls.length,before);
  }finally{db.close();}
});

test("malformed, raw, tampered, expired and unknown-key cursors fail without any WHOOP request",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    const first=content(await call(db,B,"get_recovery",{auto_page:true}));
    const cursor=first.next_token;
    const before=whoop.calls.length;
    // Shape failures are argument errors.
    for(const bad of ["../../admin","wlc1",btoa(`${B}:recovery:100`),"wlc1.k1.short.x","wlc1.k9."+"A".repeat(16)+"."+"A".repeat(40),
      cursor+"!",cursor.replace("wlc1.","wlc2."),"x".repeat(5000),cursor+"."+cursor]){
      const body=await call(db,B,"get_recovery",{next_token:bad});
      assert.equal(body.error?.code,-32602,bad.slice(0,40));
    }
    // Authenticated-encryption failures are tool errors that say to restart.
    const parts=cursor.split(".");
    const flip=s=>s.slice(0,-2)+(s.at(-2)==="A"?"B":"A")+s.at(-1);
    const tampered=[
      [parts[0],parts[1],parts[2],flip(parts[3])].join("."),
      [parts[0],parts[1],flip(parts[2]),parts[3]].join("."),
      [parts[0],"k2",parts[2],parts[3]].join(".") // k2 is not configured
    ];
    for(const bad of tampered){
      const body=await call(db,B,"get_recovery",{auto_page:true,next_token:bad});
      assert.equal(body.result.isError,true);
      assert.match(body.result.content[0].text,/not valid for this account and history category/);
    }
    const expired=await sealCursor({env:baseEnv,userId:B,resource:"recovery",query:{},whoopToken:btoa(`${B}:recovery:100`),depth:4,now:()=>Date.now()-CURSOR_TTL_MS-1});
    const late=await call(db,B,"get_recovery",{next_token:expired});
    assert.equal(late.result.isError,true);
    assert.match(late.result.content[0].text,/expired/);
    assert.equal(whoop.calls.length,before);
    // No raw WHOOP cursor or token material is ever returned.
    assert.doesNotMatch(JSON.stringify(first),new RegExp(btoa(`${B}:recovery:100`).replace(/[+/=]/g,"\\$&")));
    assert.doesNotMatch(JSON.stringify(first),/access-|refresh-/);
  }finally{db.close();}
});

test("repeated cursors are idempotent retries; WHOOP cursor loops end the sequence as incomplete",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    const cursor=content(await call(db,B,"get_cycles",{auto_page:true})).next_token;
    const once=content(await call(db,B,"get_cycles",{auto_page:true,next_token:cursor}));
    const twice=content(await call(db,B,"get_cycles",{auto_page:true,next_token:cursor}));
    assert.deepEqual(ids(once.records),ids(twice.records));
    assert.deepEqual(ids(once.records),expected(B,"cycles",100,200));
    // WHOOP returning the cursor it was given (or an earlier one) is a loop.
    for(const loopAt of [1,2]){
      let seen=[];
      const looping={calls:[],fetch:async(url,options)=>{
        const raw=new URL(url).searchParams.get("nextToken");seen.push(raw);
        const token=loopAt===1?(raw??"T0"):(raw==null?"T0":raw==="T0"?"T1":"T0");
        return new Response(JSON.stringify({records:[{id:seen.length}],next_token:token}),{status:200});
      }};
      const start=content(await setup(looping)(db,B,"get_workouts",{auto_page:true}));
      assert.equal(start.complete,false);
      assert.equal(start.next_token,null);
      assert.equal(start.incomplete_reason,"invalid_upstream_cursor");
      assert.ok(start.pages_fetched<=4);
    }
    // Manual mode: same detection.
    const echo={fetch:async(url)=>new Response(JSON.stringify({records:[{id:1}],next_token:new URL(url).searchParams.get("nextToken")??"T0"}),{status:200})};
    const c=content(await setup(echo)(db,B,"get_workouts",{limit:5})).next_token;
    const out=content(await setup(echo)(db,B,"get_workouts",{limit:5,next_token:c}));
    assert.equal(out.next_token,null);assert.equal(out.incomplete_reason,"invalid_upstream_cursor");
    // An upstream cursor with forbidden characters is never sealed or forwarded.
    const bad={fetch:async()=>new Response(JSON.stringify({records:[],next_token:"../../admin"}),{status:200})};
    const badOut=content(await setup(bad)(db,B,"get_sleep",{auto_page:true}));
    assert.equal(badOut.next_token,null);assert.equal(badOut.incomplete_reason,"invalid_upstream_cursor");
  }finally{db.close();}
});

test("a cursor replayed on another history endpoint is rejected without a WHOOP request",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    for(const [name,[resource]] of Object.entries(ENDPOINTS)){
      const cursor=content(await call(db,B,name,{auto_page:true})).next_token;
      const before=whoop.calls.length;
      for(const other of Object.keys(ENDPOINTS).filter(n=>n!==name)){
        const body=await call(db,B,other,{auto_page:true,next_token:cursor});
        assert.equal(body.result.isError,true,`${name} cursor on ${other}`);
      }
      // Non-history tools take no cursor at all.
      assert.equal((await call(db,B,"get_profile",{next_token:cursor})).error.code,-32602);
      assert.equal(whoop.calls.length,before);
      assert.ok(resource);
    }
  }finally{db.close();}
});

test("failed or incomplete WHOOP pages return what was read and resume at the failed page",async()=>{
  const db=await fixture();
  try{
    // Third page of the first call fails once with 500, then once with 429.
    let failures=[{offset:50,status:500},{offset:150,status:429}];
    const whoop=fakeWhoop({fail:({offset})=>{
      const i=failures.findIndex(f=>f.offset===offset);
      if(i<0)return null;
      const [f]=failures.splice(i,1);return new Response("{}",{status:f.status});
    }});
    const call=setup(whoop);
    const first=content(await call(db,B,"get_recovery",{auto_page:true}));
    assert.deepEqual(ids(first.records),expected(B,"recovery",0,50));
    assert.equal(first.complete,false);assert.equal(first.incomplete_reason,"upstream_error");
    assert.equal(first.pages_fetched,2);assert.ok(first.next_token);
    const second=content(await call(db,B,"get_recovery",{auto_page:true,next_token:first.next_token}));
    assert.deepEqual(ids(second.records),expected(B,"recovery",50,150));
    assert.equal(second.complete,false);assert.equal(second.incomplete_reason,undefined);
    // A failure on the first page of a call is a generic error, as before (here the 429)...
    const third=await call(db,B,"get_recovery",{auto_page:true,next_token:second.next_token});
    assert.equal(third.result.isError,true);
    // ...and the same cursor can simply be retried.
    const body=await call(db,B,"get_recovery",{auto_page:true,next_token:second.next_token});
    assert.deepEqual(ids(content(body).records),expected(B,"recovery",150,230));
    assert.equal(content(body).complete,true);
    // A malformed page mid-sequence is reported the same way.
    const mal=fakeWhoop({fail:({offset})=>offset===25?new Response(JSON.stringify({records:"nope"}),{status:200}):null});
    const partial=content(await setup(mal)(db,B,"get_sleep",{auto_page:true}));
    assert.equal(partial.records.length,25);assert.equal(partial.incomplete_reason,"upstream_error");
    // Manual pages get the same validation: missing, non-array or oversized
    // records are an error, never complete: true (Codex P2 on f1c09f7).
    for(const page of [{next_token:null},{records:"nope",next_token:null},{records:Array.from({length:11},(_,i)=>({id:i})),next_token:null}]){
      const bad={fetch:async()=>new Response(JSON.stringify(page),{status:200})};
      const res=await setup(bad)(db,B,"get_sleep",{limit:10});
      assert.equal(res.result.isError,true,JSON.stringify(page).slice(0,40));
      assert.equal(res.result.structuredContent,undefined);
    }
    // Nothing read at all: generic tool error, no partial data or details.
    const down=fakeWhoop({fail:()=>new Response("SECRET upstream body",{status:503})});
    const err=await setup(down)(db,B,"get_sleep",{auto_page:true});
    assert.equal(err.result.isError,true);
    assert.doesNotMatch(JSON.stringify(err),/SECRET/);
  }finally{db.close();}
});

// Coverage follow-up to PR #72: failures during pagination never claim
// completeness or missing WHOOP data, in the text or structuredContent.
const both=body=>[JSON.parse(body.result.content[0].text),body.result.structuredContent];
test("partial auto_page failures and later-page errors are never reported as complete or missing",async()=>{
  const db=await fixture();
  try{
    // (1) auto_page: page 3 (offset 50) fails with 500 or 429 after two pages were read.
    for(const [status,reason] of [[500,"upstream_error"],[429,"rate_limited"]]){
      let failing=true;
      const whoop=fakeWhoop({fail:({offset})=>failing&&offset===50?new Response("{}",{status}):null});
      const call=setup(whoop);
      const body=await call(db,B,"get_recovery",{auto_page:true});
      assert.equal(body.result.isError,undefined,status+" partial is not a tool error");
      const views=both(body);assert.ok(views[1],"structuredContent present");
      for(const v of views){
        assert.deepEqual(ids(v.records),expected(B,"recovery",0,50),"records already read are preserved");
        assert.equal(v.complete,false);assert.equal(v.incomplete_reason,reason);
        assert.equal(typeof v.next_token,"string");assert.ok(v.next_token.length>0);
        assert.equal(v.source,"whoop");
        const m=v.whoop_measurements;
        assert.equal(m.missing,false);assert.equal(m.records_status,"records_returned");assert.equal(m.records_returned,50);
        assert.notEqual(m.records_status,"none_in_range");
      }
      assert.deepEqual(views[0],views[1],"text and structuredContent agree");
      // The sealed cursor resumes exactly at the failed page.
      failing=false;
      const resumed=content(await call(db,B,"get_recovery",{auto_page:true,next_token:views[1].next_token}));
      assert.deepEqual(ids(resumed.records).slice(0,1),expected(B,"recovery",50,51));
    }
    // (1b) auto_page: an empty first page with a next token, then a failure.
    // Nothing was read, but more may exist: never none_in_range or missing.
    for(const [status,reason] of [[500,"upstream_error"],[429,"rate_limited"]]){
      let n=0;
      const whoop={fetch:async()=>++n===1?
        new Response(JSON.stringify({records:[],next_token:btoa(`${B}:recovery:25`)}),{status:200,headers:{"content-type":"application/json"}}):
        new Response("{}",{status})};
      const body=await setup(whoop)(db,B,"get_recovery",{auto_page:true});
      assert.equal(body.result.isError,undefined,status+" empty partial is not a tool error");
      const views=both(body);assert.ok(views[1],"structuredContent present");
      for(const v of views){
        assert.deepEqual(v.records,[]);
        assert.equal(v.complete,false);assert.equal(v.incomplete_reason,reason);
        assert.equal(typeof v.next_token,"string");assert.ok(v.next_token.length>0);
        const m=v.whoop_measurements;
        assert.equal(m.missing,false);assert.equal(m.records_status,"empty_page_more_may_exist");
        assert.equal(m.records_returned,0);assert.equal(m.stale,null);assert.equal(m.stale_reason,"page_incomplete");
      }
      assert.deepEqual(views[0],views[1],"text and structuredContent agree");
    }
    // (2) A WHOOP failure on a later page reached with next_token (manual and
    // auto_page) is an error, never missing data or none_in_range.
    for(const status of [500,503,429]){
      let failing=false;
      const whoop=fakeWhoop({fail:({offset})=>failing&&offset>0?new Response("{}",{status}):null});
      const call=setup(whoop);
      const first=content(await call(db,B,"get_sleep",{limit:25}));
      assert.equal(first.complete,false);assert.ok(first.next_token);
      failing=true;
      for(const args of [{limit:25,next_token:first.next_token},{auto_page:true,next_token:first.next_token}]){
        const err=await call(db,B,"get_sleep",args);
        assert.equal(err.result.isError,true,status+" "+JSON.stringify(Object.keys(args)));
        assert.equal(err.result.structuredContent,undefined);
        // Check the unescaped text itself (Codex P2: JSON.stringify of the outer
        // response escapes inner quotes, so a quoted pattern could never match).
        const texts=err.result.content.map(c=>c.text);assert.ok(texts.length>0);
        for(const text of texts)
          assert.doesNotMatch(text,/whoop_measurements|"missing"|\bmissing\b\s*[:=]\s*true|none_in_range|"complete"\s*:\s*true|continuation_page_empty/);
      }
      // The same cursor still works once WHOOP recovers.
      failing=false;
      const ok=content(await call(db,B,"get_sleep",{limit:25,next_token:first.next_token}));
      assert.deepEqual(ids(ok.records),expected(B,"sleep",25,50));
      assert.equal(ok.whoop_measurements.missing,false);assert.equal(ok.whoop_measurements.records_status,"records_returned");
    }
  }finally{db.close();}
});

test("two members paging interleaved stay isolated; B cannot use A's cursor and A's still works",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    for(const [name,[resource]] of Object.entries(ENDPOINTS)){
      const got={[A]:[],[B]:[]},cursor={[A]:null,[B]:null};
      for(let round=0;round<3;round++){
        for(const member of [A,B]){
          const args=cursor[member]?{auto_page:true,next_token:cursor[member]}:{auto_page:true};
          const out=content(await call(db,member,name,args));
          assert.ok(out.records.every(r=>r.owner===member));
          got[member].push(...ids(out.records));
          if(round===0&&member===B){
            // B replays A's live cursor: rejected before WHOOP is called.
            const before=whoop.calls.length;
            const stolen=await call(db,B,name,{auto_page:true,next_token:cursor[A]});
            assert.equal(stolen.result.isError,true);
            assert.doesNotMatch(JSON.stringify(stolen),/"owner"/);
            const stolenManual=await call(db,B,name,{limit:25,next_token:cursor[A]});
            assert.equal(stolenManual.result.isError,true);
            assert.equal(whoop.calls.length,before);
          }
          cursor[member]=out.next_token;
        }
      }
      assert.deepEqual(got[A],expected(A,resource));
      assert.deepEqual(got[B],expected(B,resource));
    }
    // Every WHOOP request used the bearer of the member that was authenticated.
    assert.ok(whoop.calls.every(c=>(c.user===A||c.user===B)&&!c.foreign));
  }finally{db.close();}
});

test("seat roles, membership and stored credentials are unchanged by paging; both seat types page identically",async()=>{
  const db=await fixture({users:[[A,"developer"],[B,"public"],[C,"public"]]});
  try{
    const snapshot=()=>JSON.stringify(["whoop_connections","whoop_members","identity_links"].map(t=>db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY user_id`).all()));
    const before=snapshot();
    const whoop=fakeWhoop(),call=setup(whoop);
    const shapes={};
    for(const member of [A,B,C]){
      let cursor=null,pages=[];
      do{const out=content(await call(db,member,"get_recovery",cursor?{auto_page:true,next_token:cursor}:{auto_page:true}));
        pages.push(out.records.length);cursor=out.next_token;}while(cursor);
      shapes[member]=pages;
    }
    assert.deepEqual(shapes[A],[100,100,30]);
    assert.deepEqual(shapes[B],shapes[A]);assert.deepEqual(shapes[C],shapes[A]);
    assert.equal(snapshot(),before);
    const roles=db.sqlite.prepare("SELECT user_id,seat_role FROM whoop_connections ORDER BY user_id").all().map(r=>[r.user_id,r.seat_role]);
    assert.deepEqual(roles,[[A,"developer"],[B,"public"],[C,"public"]]);
    // An inactive member's cursor stops working even though it was valid.
    const cursor=content(await call(db,C,"get_sleep",{auto_page:true})).next_token;
    db.sqlite.prepare("UPDATE whoop_members SET active=0 WHERE user_id=?").run(C);
    const route=createStagingRouter({verifyIdentity:async()=>C,whoopRequest:()=>{throw Error("no call");}});
    const res=await route(new Request("https://staging.invalid/mcp",{method:"POST",headers:{"content-type":"application/json",
      accept:"application/json, text/event-stream","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":"get_sleep"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_sleep",arguments:{next_token:cursor}}})}),{...baseEnv,DB:db});
    assert.equal(res.status,403);
  }finally{db.close();}
});

test("pagination depth is capped per sequence and the cap is not reset by a new cursor",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop(),call=setup(whoop);
    const deep=await sealCursor({env:baseEnv,userId:B,resource:"sleep",query:{},whoopToken:btoa(`${B}:sleep:25`),depth:SEQUENCE_MAX_PAGES-1});
    const auto=content(await call(db,B,"get_sleep",{auto_page:true,next_token:deep}));
    assert.equal(auto.pages_fetched,1);assert.equal(auto.next_token,null);
    assert.equal(auto.complete,false);assert.equal(auto.incomplete_reason,"page_limit");
    const manual=content(await call(db,B,"get_sleep",{limit:25,next_token:deep}));
    assert.equal(manual.next_token,null);assert.equal(manual.incomplete_reason,"page_limit");
    await assert.rejects(sealCursor({env:baseEnv,userId:B,resource:"sleep",query:{},whoopToken:"T",depth:SEQUENCE_MAX_PAGES+1}),CursorError);
  }finally{db.close();}
});

test("cursor crypto binds member, endpoint, window and key; uses the existing token key via HKDF",async()=>{
  const args={env:baseEnv,userId:A,resource:"recovery",query:{},whoopToken:"MTIzOjEyMzEyMw==",depth:1};
  const cursor=await sealCursor(args);
  assert.match(cursor,/^wlc1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(cursor,/MTIzOjEyMzEyMw/);
  const opened=await openCursor({...args,cursor});
  assert.deepEqual({whoopToken:opened.whoopToken,depth:opened.depth},{whoopToken:"MTIzOjEyMzEyMw==",depth:1});
  // issuedAt is derived from the sealed expiry (used for the disconnect check).
  assert.ok(Math.abs(opened.issuedAt-Date.now())<5000);
  // Member ids are case-normalized, so the same member always matches.
  assert.ok(await openCursor({...args,userId:A.toUpperCase(),cursor}));
  for(const change of [{userId:B},{resource:"sleep"},{query:{start:"2026-01-01T00:00:00Z"}},{env:{...baseEnv,WHOOP_TOKEN_AES256_KEY:nextKey}}])
    await assert.rejects(openCursor({...args,...change,cursor}),e=>e instanceof CursorError&&e.reason==="invalid");
  await assert.rejects(openCursor({...args,cursor,now:()=>Date.now()+CURSOR_TTL_MS}),e=>e.reason==="expired");
  // Rotation: with NEXT staged new cursors use k2 and old k1 cursors still open.
  const rotating={...baseEnv,WHOOP_TOKEN_AES256_KEY_NEXT:nextKey};
  const k2=await sealCursor({...args,env:rotating});
  assert.match(k2,/^wlc1\.k2\./);
  assert.ok(await openCursor({...args,env:rotating,cursor}));
  assert.ok(await openCursor({...args,env:rotating,cursor:k2}));
  // No key configured: sealing fails closed.
  await assert.rejects(sealCursor({...args,env:{}}),CursorError);
});

test("REST history routes use the same member-bound cursors",async()=>{
  const db=await fixture();
  try{
    const whoop=fakeWhoop();
    const route=createStagingRouter({verifyIdentity:async(r)=>r.headers.get("x-synthetic-member"),
      whoopRequest:(d,u,r,e,o)=>callWhoop(d,u,r,e,o,{fetcher:whoop.fetch})});
    const get=(member,path)=>route(new Request("https://staging.invalid"+path,{headers:{authorization:"Bearer s","x-synthetic-member":member}}),{...baseEnv,DB:db});
    let res=await get(A,"/v1/whoop/workouts?limit=25");
    const first=(await res.json()).data;
    assert.match(first.next_token,/^wlc1\./);
    const before=whoop.calls.length;
    assert.equal((await get(B,"/v1/whoop/workouts?limit=25&next_token="+first.next_token)).status,400);
    assert.equal((await get(A,"/v1/whoop/sleep?limit=25&next_token="+first.next_token)).status,400);
    assert.equal((await get(A,"/v1/whoop/workouts?next_token="+btoa(`${A}:workouts:25`))).status,400);
    assert.equal((await get(A,"/v1/whoop/profile?next_token="+first.next_token)).status,400);
    assert.equal(whoop.calls.length,before);
    res=await get(A,"/v1/whoop/workouts?limit=25&next_token="+first.next_token);
    assert.deepEqual(ids((await res.json()).data.records),expected(A,"workouts",25,50));
  }finally{db.close();}
});
