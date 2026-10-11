import assert from "node:assert/strict";
import test from "node:test";
import {createSamsungHealthHandler,validateHealthConnect} from "../samsung-health/handler.mjs";

const userA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const eventDate="2026-10-10T12:00:00Z";
function fixture(){
  const store={whoop_connections:[{user_id:userA},{user_id:userB}],whoop_members:[],samsung_health_records:[],health_connect_records:[]};
  const auth={a:userA,b:userB};
  let writes=0;
  const db={
    auth:{async getUser(token){return {data:{user:auth[token]?{id:auth[token]}:null},error:null}}},
    from(table){
      let data=store[table],filter=[],ascending=true,range=null,max=null,op="select",input=null,opts={};
      if(!data)throw Error("invalid table");
      const q={
        select(){return q;},eq(k,v){filter.push([k,v]);return q;},
        order(k,options){ascending=options?.ascending??true;return q;},
        limit(v){max=v;return q;},range(a,b){range=[a,b];return q;},
        maybeSingle(){return Promise.resolve({data:data.filter(row=>filter.every(([k,v])=>row[k]===v))[0]??null,error:null})},
        upsert(rows,options){op="upsert";input=rows;opts=options??{};return q;},
        delete(){op="delete";return q;},
        then(resolve,reject){
          if(op==="delete"){
            writes++;
            const matches=data.filter(row=>filter.every(([k,v])=>row[k]===v));
            store[table]=data.filter(row=>!filter.every(([k,v])=>row[k]===v));
            return Promise.resolve({data:structuredClone(matches),error:null}).then(resolve,reject);
          }
          if(op==="upsert"){
            writes++;
            for(const incoming of input){
              const columns=(opts.onConflict??"").split(",");
              const old=data.find(row=>columns.every(k=>row[k]===incoming[k]));
              if(old&&!opts.ignoreDuplicates)Object.assign(old,incoming);
              if(!old)data.push(structuredClone(incoming));
            }
            return Promise.resolve({error:null,data:null}).then(resolve,reject);
          }
          let matches=data.filter(row=>filter.every(([k,v])=>row[k]===v));
          if(range)matches=matches.slice(range[0],range[1]+1);
          if(max)matches=matches.slice(0,max);
          return Promise.resolve({data:structuredClone(matches),error:null}).then(resolve,reject);
        }
      };
      return q;
    }
  };
  const handler=createSamsungHealthHandler({db,now:()=>Date.parse("2026-10-11T12:00:00Z")});
  async function call(token="a",body,method="POST",path=""){
    const response=await handler(new Request("https://example.test/samsung-health"+path,{
      method,
      headers:token?{authorization:"Bearer "+token}:undefined,
      body:["POST","DELETE"].includes(method)?(typeof body==="string"?body:JSON.stringify(body)):undefined
    }));
    return {status:response.status,body:await response.json()};
  }
  return {call,store,db,get writes(){return writes}};
}
const v2=()=>({schema_version:2,source:"health_connect",exported_at:eventDate,records:[
  {metric:"steps_daily",record_key:"daily:2026-10-10:UTC",observed_at:eventDate,local_date:"2026-10-10",unit:"steps",payload:{count:3000}},
  {metric:"heart_rate",record_key:"hr:record-1",observed_at:eventDate,origin_package:"com.example.health",unit:"bpm",payload:{bpm:64}}
]});
const v1=()=>({schema_version:1,source:"samsung_health",transport:"samsung_health_data_sdk",exported_at:eventDate,records:[{metric:"steps",source:"samsung_health",transport:"samsung_health_data_sdk",sdk_record:{startTime:eventDate,count:3000}}]});

test("new v2 source verifies bearer, existing WHOOP access and active membership",async()=>{
  const t=fixture();
  assert.equal((await t.call(null,v2())).status,401);
  assert.equal((await t.call("wrong",v2())).status,401);
  assert.equal((await t.call("a",v2())).status,200);
  t.store.whoop_members.push({user_id:userA,active:false});
  assert.equal((await t.call("a",v2())).status,403);
  assert.equal((await t.call("b",v2())).status,200);
  t.store.whoop_connections.pop();
  assert.equal((await t.call("b",v2())).status,403);
});
test("v2 import derives ownership from token and upserts stable key corrections",async()=>{
  const t=fixture();const body=v2();body.user_id=userB;
  let r=await t.call("a",body);
  assert.equal(r.status,200);assert.deepEqual(r.body,{accepted:2,schema_version:2});
  assert.equal(t.store.health_connect_records.length,2);
  assert.ok(t.store.health_connect_records.every(row=>row.user_id===userA));
  const corrected=v2();corrected.records[0].payload.count=3456;
  r=await t.call("a",corrected);
  assert.equal(r.status,200);
  assert.equal(t.store.health_connect_records.length,2);
  assert.equal(t.store.health_connect_records.find(r=>r.metric==="steps_daily").payload.count,3456);
  assert.equal(t.store.samsung_health_records.length,0);
});
test("v1 upload and GET compatibility stay source-labeled and deduplicated",async()=>{
  const t=fixture();
  assert.equal((await t.call("a",v1())).body.accepted,1);
  assert.equal((await t.call("a",v1())).body.accepted,1);
  assert.equal(t.store.samsung_health_records.length,1);
  const read=await t.call("a",undefined,"GET","?metric=steps");
  assert.equal(read.status,200);assert.equal(read.body.records.length,1);
  assert.equal(read.body.records[0].source,"samsung_health");
  assert.equal(read.body.records[0].transport,"samsung_health_data_sdk");
});
test("no writes for empty, oversized, wrong source or malformed v2 payload",async()=>{
  const t=fixture();
  for(const bad of [
    {...v2(),source:"samsung_health"},{...v2(),records:new Array(101).fill(v2().records[0])},
    {...v2(),records:[{...v2().records[0],unit:"beats"}]},
    {...v2(),records:[{...v2().records[0],payload:{count:-1}}]},
    {...v2(),records:[{...v2().records[0],record_key:"bad private/id"}]},
    {...v2(),records:[{...v2().records[0],payload:{count:1,diagnosis:"something"}}]},
  ]) assert.equal((await t.call("a",bad)).status,400);
  assert.equal(t.writes,0);
  assert.equal((await t.call("a",{...v2(),records:[]})).body.accepted,0);
  assert.equal(t.writes,0);
  assert.equal((await t.call("a","{invalid")).status,400);
  assert.equal((await t.call("a","x".repeat(513000))).status,413);
});
test("v2 strict allowlist does not accept fake diagnosis or unknown units",()=>{
  assert.equal(validateHealthConnect({...v2(),records:[{...v2().records[0],metric:"diagnosis"}]},Date.parse("2026-10-11")).error,"Invalid Health Connect record");
  assert.ok(validateHealthConnect(v2(),Date.parse("2026-10-11")).rows.length===2);
});

test("user-approved v2 DELETE only removes owner-matching records and never Samsung v1",async()=>{
  const t=fixture();await t.call("a",v2());await t.call("b",v2());await t.call("a",v1());
  const key=v2().records[0].record_key;
  const item={schema_version:2,source:"health_connect",approved:true,metric:"steps_daily",record_key:key};
  assert.equal((await t.call("a","", "DELETE")).status,400);
  assert.equal((await t.call("a",{...item,approved:false},"DELETE")).status,400);
  assert.equal((await t.call("a",{...item,record_key:"invalid/private/key"},"DELETE")).status,400);
  const removed=await t.call("a",item,"DELETE");
  assert.equal(removed.status,200);
  assert.equal(removed.body.deleted,1);
  assert.equal(t.store.health_connect_records.filter(r=>r.user_id===userA&&r.metric==="steps_daily").length,0);
  assert.equal(t.store.health_connect_records.filter(r=>r.user_id===userB&&r.metric==="steps_daily").length,1);
  assert.equal(t.store.samsung_health_records.length,1);
  const again=await t.call("a",item,"DELETE");
  assert.equal(again.body.deleted,0);
});
