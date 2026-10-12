import assert from "node:assert/strict";
import test from "node:test";
import {createMedicalContextHandler} from "../medical-context/handler.mjs";

const a="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id="11111111-1111-4111-8111-111111111111";
function fixture(){
  const tables={whoop_connections:[{user_id:a},{user_id:b}],whoop_members:[{user_id:a,active:true},{user_id:b,active:true}],medical_context_entries:[]};
  const db={
    auth:{async getUser(token){return {data:{user:token==="a"?{id:a}:token==="b"?{id:b}:null},error:null}}},
    from(table){
      const rows=tables[table];if(!rows)throw Error("unknown table");
      let filters=[],operation="read",payload;
      const q={
        select(){return q},
        eq(k,v){filters.push([k,v]);return q},
        order(){return q},limit(){return q},
        insert(x){operation="insert";payload=x;return q},
        update(x){operation="update";payload=x;return q},
        delete(){operation="delete";return q},
        maybeSingle(){return Promise.resolve(run(true))},
        then(ok,bad){return Promise.resolve(run(false)).then(ok,bad)}
      };
      function run(one){
        const matches=row=>filters.every(([k,v])=>row[k]===v);
        let found=rows.filter(matches);
        if(operation==="insert"){rows.push(structuredClone(payload));found=[payload]}
        if(operation==="update"){for(const row of found)Object.assign(row,structuredClone(payload))}
        if(operation==="delete"){for(const row of found){const i=rows.indexOf(row);if(i>=0)rows.splice(i,1)}}
        const result=one?(found[0]??null):found;
        return {data:structuredClone(result),error:null};
      }
      return q;
    }
  };
  const handle=createMedicalContextHandler({db,randomUUID:()=>id});
  async function call(token,method,body,path=""){
    const response=await handle(new Request("https://example.test/medical-context"+path,{
      method,headers:token?{authorization:"Bearer "+token}:undefined,
      body:body===undefined?undefined:JSON.stringify(body)
    }));
    return {status:response.status,body:await response.json()};
  }
  return {call,tables};
}
const entry=()=>({approved:true,category:"note",source_type:"self_reported",
  source_label:"Personal notes",source_date:"2026-10-10",detail_json:{title:"Question to ask",description:"Synthetic example only"}});
test("medical context requires authenticated existing, active member",async()=>{
  const h=fixture();
  assert.equal((await h.call(null,"GET")).status,401);
  assert.equal((await h.call("bogus","GET")).status,401);
  assert.equal((await h.call("a","GET")).status,200);
  h.tables.whoop_members.find(m=>m.user_id===a).active=false;
  assert.equal((await h.call("a","GET")).status,403);
  h.tables.whoop_connections.splice(1,1);
  assert.equal((await h.call("b","GET")).status,403);
});
test("medical context cannot be saved without explicit user review",async()=>{
  const h=fixture();
  assert.equal((await h.call("a","POST",{...entry(),approved:false})).status,400);
  assert.equal((await h.call("a","POST",{...entry(),category:"diagnosis"})).status,400);
  assert.equal((await h.call("a","POST",{...entry(),detail_json:{title:"test",api_key:"private"}})).status,400);
  assert.equal(h.tables.medical_context_entries.length,0);
  const saved=await h.call("a","POST",{...entry(),user_id:b});
  assert.equal(saved.status,200);assert.equal(saved.body.id,id);
  assert.equal(h.tables.medical_context_entries[0].user_id,a);
  assert.equal(h.tables.medical_context_entries[0].source_type,"self_reported");
  assert.equal((await h.call("a","GET")).body.entries.length,1);
  assert.equal((await h.call("b","GET")).body.entries.length,0);
});
test("only the owning user can update or delete a reviewed entry",async()=>{
  const h=fixture();
  await h.call("a","POST",entry());
  assert.equal((await h.call("b","PATCH",{...entry(),detail_json:{title:"other"}},"?id="+id)).status,404);
  assert.equal((await h.call("b","DELETE",{approved:true},"?id="+id)).status,404);
  assert.equal((await h.call("a","PATCH",{...entry(),detail_json:{title:"Updated question"}},"?id="+id)).status,200);
  assert.equal(h.tables.medical_context_entries[0].detail_json.title,"Updated question");
  assert.equal((await h.call("a","DELETE",{approved:false},"?id="+id)).status,400);
  assert.equal((await h.call("a","DELETE",{approved:true},"?id="+id)).status,200);
  assert.equal(h.tables.medical_context_entries.length,0);
});
test("malformed and unapproved requests never reveal or store private body",async()=>{
  const h=fixture();
  const error=await h.call("a","POST",{...entry(),source_label:"x".repeat(200)});
  assert.equal(error.status,400);
  assert.equal(JSON.stringify(error.body).includes("x".repeat(20)),false);
  assert.equal((await h.call("a","POST",{...entry(),detail_json:{title:"a".repeat(3000)}})).status,400);
  assert.equal(h.tables.medical_context_entries.length,0);
});
test("strict allowlist: missing whoop_members row is denied even with a WHOOP connection",async()=>{
  const h=fixture();
  h.tables.whoop_members.splice(h.tables.whoop_members.findIndex(m=>m.user_id===a),1);
  assert.equal((await h.call("a","GET")).status,403);
  assert.equal((await h.call("b","GET")).status,200);
});
