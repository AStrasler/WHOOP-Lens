import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readExtraTool,extraArguments} from '../src/extra-tools.mjs';
import {createStagingRouter} from '../src/router.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
  const sql=new DatabaseSync(':memory:');
  for(const file of ['0001_initial.sql','0004_medical_context_review.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  for(const id of [A,B]){
    sql.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sql.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
    for(let i=0;i<3;i++){
      const key=id+i,raw=JSON.stringify({syntheticOwner:id,number:i});
      sql.prepare("INSERT INTO samsung_health_records(id,user_id,metric,source_record_hash,exported_at,sdk_record_json) VALUES(?,?,'steps',?,?,?)").run(key,id,String(i).repeat(64),'2026-10-11',raw);
      sql.prepare("INSERT INTO health_connect_records(id,user_id,metric,record_key,observed_at,unit,payload_json) VALUES(?,?,'steps_daily',?,'2026-10-11','count',?)").run(key,id,key,raw);
      sql.prepare("INSERT INTO medical_context(id,user_id,source_type,source_label,category,detail_json,reviewed_at) VALUES(?,?,'self_reported','Synthetic fixture','note',?,?)").run(key,id,raw,i===0?null:'2026-10-11');
    }
  }
  return {sql,prepare(query){let args=[];return {bind(...values){args=values;return this;},
    async first(){return sql.prepare(query).get(...args)||null;},
    async all(){return {success:true,results:sql.prepare(query).all(...args)};}};}};
}
test('local reads isolate accounts, deserialize JSON and paginate deterministically',async()=>{
  const db=fixture();try{
    for(const tool of ['get_samsung_health','get_health_connect','get_medical_context']){
      const first=await readExtraTool(db,A,tool,{limit:1,offset:0});
      const next=await readExtraTool(db,A,tool,{limit:1,offset:first.next_offset});
      assert.equal(first.next_offset,1);
      assert.doesNotMatch(JSON.stringify(first),new RegExp(B));
      assert.match(JSON.stringify(first),new RegExp(A));
      assert.notDeepEqual(first.records||first.entries,next.records||next.entries);
      const full=await readExtraTool(db,A,tool,{limit:100,offset:0});
      const records=full.records||full.entries;
      assert.equal(records.length,tool==='get_medical_context'?2:3);
      assert.equal(full.next_offset,null);
      if(tool==='get_medical_context')assert.ok(records.every(r=>r.reviewed_at));
      else assert.equal(typeof (records[0].sdk_record||records[0].payload),'object');
    }
    const filtered=await readExtraTool(db,A,'get_samsung_health',{metric:'sleep',limit:25,offset:0});
    assert.deepEqual(filtered.records,[]);
    db.sql.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
    await assert.rejects(readExtraTool(db,A,'get_samsung_health',{}),/Not authorized/);
  }finally{db.sql.close();}
});
test('all added tools reject owner overrides and invalid bounded inputs',()=>{
  for(const tool of ['get_samsung_health','get_health_connect','get_medical_context','get_capabilities','connect_whoop']){
    assert.equal(extraArguments(tool,{user_id:B}),null);
    assert.equal(extraArguments(tool,{sql:'SELECT *'}),null);
    assert.equal(extraArguments(tool,[]),null);
  }
  for(const args of [{metric:'unknown'},{limit:101},{offset:-1},{offset:100001},{limit:1.2}])
    assert.equal(extraArguments('get_samsung_health',args),null);
  assert.equal(extraArguments('get_health_connect',{metric:'steps'}),null);
  assert.equal(extraArguments('get_capabilities',{include_planned:'yes'}),null);
});
test('capability availability is scoped to existing records and bounded filters',async()=>{
  const db=fixture();try{
    const catalog=await readExtraTool(db,A,'get_capabilities',{});
    assert.equal(catalog.capabilities.find(c=>c.id==='samsung').status,'available');
    const optional=await readExtraTool(db,A,'get_capabilities',{category:'optional',limit:1,offset:0});
    assert.equal(optional.capabilities.length,1);assert.equal(optional.next_offset,1);
    db.sql.prepare('DELETE FROM samsung_health_records WHERE user_id=?').run(A);
    const absent=await readExtraTool(db,A,'get_capabilities',{});
    assert.equal(absent.capabilities.find(c=>c.id==='samsung').status,'requires_connection_or_data');
    assert.ok(absent.capabilities.find(c=>c.id==='health-connect').tools.includes('get_health_connect'));
  }finally{db.sql.close();}
});
test('connect MCP dispatch uses verified identity and separate connection gate',async()=>{
  const db=fixture();try{
    let calls=0;
    const route=createStagingRouter({verifyIdentity:async()=>A,
      whoopAuthorize:async(d,id)=>{assert.equal(d,db);assert.equal(id,A);calls++;
        return {authorization_url:'https://api.prod.whoop.com/oauth/oauth2/auth?state=synthetic'};}});
    const request=()=>new Request('https://whooplens.tech/mcp',{method:'POST',headers:{
      'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'connect_whoop',arguments:{}}})});
    const env={DB:db,MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true'};
    assert.equal((await (await route(request(),env)).json()).result.isError,true);
    assert.equal(calls,0);
    const result=await (await route(request(),{...env,WHOOP_OAUTH_ENABLED:'true'})).json();
    assert.match(result.result.content[0].text,/^https:\/\/api.prod.whoop.com/);
    assert.equal(calls,1);
  }finally{db.sql.close();}
});
