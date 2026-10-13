import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createStagingRouter } from "../src/router.mjs";
import { handleMcpRpc, validateMcpTransport, mcpTools } from "../src/mcp.mjs";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cfg=readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8");
const modern="2026-07-28";
const legacy="2025-11-25";
function payload(method,id=1,params={}){return {jsonrpc:"2.0",id,method,params};}
function req(message,{version=modern,origin=null,accept="application/json, text/event-stream",auth="Bearer sample-token",method="POST",json=true,headers={}}={}){
  const h={accept,authorization:auth,...headers};
  if(json)h["content-type"]="application/json";
  if(origin)h.origin=origin;
  if(version){h["mcp-protocol-version"]=version;h["mcp-method"]=message.method;
    if(message.method==="tools/call")h["mcp-name"]=message.params?.name;}
  Object.assign(h,headers); // Deliberate invalid-header overrides must survive setup.
  return new Request("https://staging.invalid/mcp",{method,headers:h,body:method==="POST"?JSON.stringify(message):undefined});
}
function db({member=true}={}){
  let count=0;
  return {
    count:()=>count,
    prepare(query){count++;return {bind(...values){assert.equal(values[0],A);return this;},async first(){
      assert.match(query,/whoop_members/);return member?{user_id:A}:null;
    }};}
  };
}
const data={records:[{test:"synthetic"}],next_token:null};
const fakeIdentity=async()=>A;
const enabled=(database)=>({DB:database,MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"true"});
function router(args={}){return createStagingRouter({verifyIdentity:fakeIdentity,whoopRequest:async()=>data,...args});}

test("MCP is entirely inert until its third switch is enabled",async()=>{
  const database=db();let checked=0,called=0;
  const route=router({verifyIdentity:async()=>{checked++;return A;},whoopRequest:async()=>{called++;return data;}});
  const response=await route(req(payload("tools/call",1,{name:"get_recovery",arguments:{limit:10}})),{
    DB:database,MIGRATION_API_ENABLED:"true",WHOOP_READS_ENABLED:"true",MCP_ENABLED:"false"
  });
  assert.equal(response.status,503);
  assert.equal(checked,0);assert.equal(called,0);assert.equal(database.count(),0);
  for(const key of ["MIGRATION_API_ENABLED","WHOOP_READS_ENABLED","WHOOP_OAUTH_ENABLED","MCP_ENABLED","WEB_HEALTH_IMPORT_ENABLED"])
    assert.match(cfg,new RegExp('"'+key+'"\\s*:\\s*"false"'));
  assert.match(cfg,/"workers_dev"\s*:\s*false/);
  assert.match(cfg,/"preview_urls"\s*:\s*false/);
});

test("MCP 2026 protocol discovers fourteen bounded account tools",async()=>{
  const route=router();
  const result=await route(req(payload("tools/list")),enabled(db()));
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.result.resultType,"complete");
  assert.equal(body.result.cacheScope,"private");
  assert.equal(body.result.tools.length,14);
  assert.deepEqual(body.result.tools.map(x=>x.name),mcpTools.map(x=>x.name));
  const writes=new Set(['connect_whoop','disconnect_whoop','import_health_connect_file','withdraw_health_connect_import']);
  const destructive=new Set(['disconnect_whoop','withdraw_health_connect_import']);
  assert.ok(body.result.tools.every(t=>t.annotations.readOnlyHint===!writes.has(t.name)&&t.annotations.destructiveHint===destructive.has(t.name)));
  assert.doesNotMatch(JSON.stringify(body.result.tools),/delete_|write_|admin_sql/);
  const discover=await route(req(payload("server/discover")),enabled(db()));
  const discovery=(await discover.json()).result;
  assert.equal(discovery.serverInfo.name,"whoop-lens");
  assert.equal(discovery.serverInfo.version,"1.0.0");
  assert.match(discovery.instructions,/WHOOP Stress Monitor history is not in the official WHOOP developer API/);
  assert.match(discovery.instructions,/Do not estimate those durations/);
  assert.equal(discovery.cacheScope,"private");
  assert.equal(discovery.ttlMs,0);
});

test("Modern MCP tools call accepts only known categories and uses verified identity",async()=>{
  const historyNames={get_recovery:"recovery",get_sleep:"sleep",get_workouts:"workouts",get_cycles:"cycles"};
  for(const [name,resource] of Object.entries(historyNames)){
    const invoked=[];
    const route=router({whoopRequest:async (_db,userId,r,_env,opts)=>{
      invoked.push({userId,r,opts});return {records:[{owner:A}],next_token:null};
    }});
    const msg=payload("tools/call",51,{name,arguments:{limit:12}});
    const response=await route(req(msg),enabled(db()));
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.id,51);
    assert.equal(body.result.resultType,"complete");
    assert.equal(body.result.structuredContent.records[0].owner,A);
    assert.equal(invoked.length,1);
    assert.equal(invoked[0].userId,A);assert.equal(invoked[0].r,resource);
    assert.equal(invoked[0].opts.limit,12);
  }
  for(const [name,resource] of [["get_profile","profile"],["get_body_measurements","measurements"]]){
    const calls=[];
    const response=await router({whoopRequest:async (_,id,r)=>{calls.push([id,r]);return {synthetic:true};}})
      (req(payload("tools/call",1,{name,arguments:{}})),enabled(db()));
    assert.equal(response.status,200);
    assert.deepEqual(calls,[[A,resource]]);
  }
});

test("Legacy initialization and tools/list continue without exposing arbitrary methods",async()=>{
  const route=router();
  const init=await route(req(payload("initialize",1,{protocolVersion:legacy,capabilities:{},
    clientInfo:{name:"test",version:"1"}}),{version:legacy}),enabled(db()));
  assert.equal(init.status,200);
  const initBody=await init.json();
  assert.equal(initBody.result.protocolVersion,legacy);
  assert.equal(initBody.result.serverInfo.name,"whoop-lens");
  assert.match(initBody.result.instructions,/call get_capabilities first/);
  assert.match(initBody.result.instructions,/label it user-provided/);
  const result=await route(req(payload("tools/list"),{version:legacy}),enabled(db()));
  const list=(await result.json()).result;
  assert.equal(list.tools.length,14);assert.equal(Object.hasOwn(list,"resultType"),false);
  const forbidden=await route(req(payload("resources/read"),{version:legacy}),enabled(db()));
  assert.equal((await forbidden.json()).error.code,-32601);
  const notification={jsonrpc:"2.0",method:"notifications/initialized",params:{}};
  const response=await route(req(notification,{version:legacy}),enabled(db()));
  assert.equal(response.status,202);
});

test("ChatGPT protocol versions initialize with the same host instructions",async()=>{
  const route=router();
  for(const version of ["2025-06-18","2025-03-26"]){
    const init=await route(req(payload("initialize",1,{protocolVersion:version,capabilities:{},
      clientInfo:{name:"chatgpt",version:"1"}}),{version:null}),enabled(db()));
    assert.equal(init.status,200);
    const body=await init.json();
    assert.equal(body.result.protocolVersion,version);
    assert.equal(body.result.serverInfo.name,"whoop-lens");
    assert.match(body.result.instructions,/WHOOP Stress Monitor history is not in the official WHOOP developer API/);
    const listed=await route(req(payload("tools/list"),{version}),enabled(db()));
    assert.equal(listed.status,200);
    assert.equal((await listed.json()).result.tools.length,14);
  }
  const modernInit=await route(req(payload("initialize",1,{protocolVersion:"2026-07-28",capabilities:{},
    clientInfo:{name:"test",version:"1"}})),enabled(db()));
  assert.equal((await modernInit.json()).error.code,-32601);
});

test("Caller cannot choose another user, unknown tool or inject extra arguments",async()=>{
  let calls=0;
  const route=router({whoopRequest:async()=>{calls++;return data;}});
  const invalid=[
    payload("tools/call",1,{name:"read_anything",arguments:{}}),
    payload("tools/call",1,{name:"get_sleep",arguments:{user_id:B}}),
    payload("tools/call",1,{name:"get_recovery",arguments:{limit:26}}),
    payload("tools/call",1,{name:"get_sleep",arguments:{auto_page:"yes"}}),
    payload("tools/call",1,{name:"get_profile",arguments:{next_token:"q"}}),
    payload("tools/call",1,{name:"get_sleep",arguments:{auto_page:true,next_token:"cursor"}}),
    payload("tools/call",1,{name:"get_recovery",arguments:{next_token:"../../admin"}})
  ];
  for(const p of invalid){
    const res=await route(req(p),enabled(db()));
    assert.equal((await res.json()).error.code,-32602);
  }
  assert.equal(calls,0);
});

test("Autopagination is bounded to 4 pages, stops on empty continuation",async()=>{
  let requests=0;const route=router({whoopRequest:async(_db,_id,resource,_env,opts)=>{
    requests++;assert.equal(resource,"recovery");assert.equal(opts.limit,25);
    return {records:[{page:requests}],next_token:requests<6?"next"+requests:null};
  }});
  const response=await route(req(payload("tools/call",1,{name:"get_recovery",arguments:{auto_page:true}})),enabled(db()));
  const body=await response.json();
  assert.equal(body.result.structuredContent.records.length,4);
  assert.equal(body.result.structuredContent.complete,false);
  assert.equal(body.result.structuredContent.next_token,"next4");
  assert.equal(requests,4);
});

test("Origin, content type, headers, bearer identity and membership block access",async()=>{
  let called=0,authenticated=0;
  const route=router({whoopRequest:async()=>{called++;return data;},
    verifyIdentity:async()=>{authenticated++;return A;}});
  const base=payload("tools/list");
  for(const request of [
    req(base,{origin:"https://evil.invalid"}),
    req(base,{version:"bogus"}),
    req(base,{headers:{"mcp-method":"tools/call"}}),
    req(payload("tools/call",1,{name:"get_profile",arguments:{}}),{headers:{"mcp-name":"get_sleep"}}),
    req(base,{accept:"application/json"}),
    req(base,{json:false}),
    req(base,{method:"GET"})
  ]){
    const response=await route(request,enabled(db()));
    assert.ok(response.status>=400, String(response.status));
  }
  assert.equal(authenticated,0);assert.equal(called,0);
  const route2=router({verifyIdentity:async()=>{throw new Error("Missing authorization");}});
  const denial=await route2(req(base),enabled(db()));
  assert.equal(denial.status,503);
  const disabled=await route(req(base),enabled(db({member:false})));
  assert.equal(disabled.status,403);
  assert.equal(called,0);
});

test("Malformed JSON-RPC bodies fail safely without accessing identity or D1",async()=>{
  let auth=0;
  const route=router({verifyIdentity:async()=>{auth++;return A;}});
  for(const bad of ["null","[]","\"hello\""]){
    const request=new Request("https://staging.invalid/mcp",{
      method:"POST",
      headers:{"accept":"application/json, text/event-stream",
        "content-type":"application/json","mcp-protocol-version":modern},
      body:bad
    });
    const response=await route(request,enabled(db()));
    assert.equal(response.status,400);
  }
  assert.equal(auth,0);
});

test("Upstream failure never exposes tokens, SQL or internal errors in tool result",async()=>{
  const route=router({whoopRequest:async()=>{throw Error("SECRET ABC invalid WHOOP refresh");}});
  const result=await route(req(payload("tools/call",1,{name:"get_profile",arguments:{}})),enabled(db()));
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.result.isError,true);
  assert.doesNotMatch(JSON.stringify(body),/SECRET ABC/);
  assert.match(JSON.stringify(body),/unavailable/);
});
