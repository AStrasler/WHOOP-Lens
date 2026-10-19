// Client-facing source-hierarchy contract, over the real MCP JSON-RPC handler:
// what any external client (ChatGPT, Claude, ...) receives with no custom
// instructions of its own. Synthetic members and records only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {connect} from './audit-fixtures.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
import {SOURCE_HIERARCHY} from '../src/member-guidance.mjs';
import {hostInstructions,memberGuidance} from '../src/host-instructions.mjs';

const MEMBER='0b0b0b0b-0000-4000-8000-00000000000b';
const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const ENV={MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',MIGRATION_API_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
const VARIANTS=[ENV,{...ENV,FLARE_JOURNAL_ENABLED:'true'},{...ENV,STRESS_ESTIMATE_ENABLED:'true',AI_SUMMARY_ENABLED:'true'},{...ENV,ISSUE_REPORTS_ENABLED:'true'}];
const RULE_WORDS=[/WHOOP measurements are authoritative/,/supplementary.*source label/,/only when the user directs it.*Never bring one in at your own discretion/,
  /Ground every interpretation in measurements retrieved.*separate from hypotheses/,/missing or stale.*Never silently fill the gap/,/required, not an optional recommendation.*Only the user decides/];
const SUBSTITUTION=/(use|fall ?back to|switch to|rely on|substitute)[^.]{0,40}(Health Connect|Samsung|another source|other source)[^.]{0,30}(instead|when WHOOP|if WHOOP)/i;

async function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  for(const id of [OWNER,MEMBER]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
  }
  await connect(sqlite,MEMBER,'public','access-'+MEMBER);
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
for(const version of ['2025-11-25','2025-06-18']){
  const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':version}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
  const rpc=(db,method,params,env=ENV,whoopRequest)=>handleMcpRpc({jsonrpc:'2.0',id:1,method,params},{db,userId:MEMBER,env,whoopRequest},transport);
  const out=r=>({text:JSON.parse(r.result.content[0].text),structured:r.result.structuredContent});

  test(`[${version}] initialize: every instructions variant leads with the full source hierarchy`,async()=>{
    const db=await fixture();try{
      for(const env of VARIANTS){
        const init=await rpc(db,'initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'plain-client',version:'1'}},env);
        const text=init.result.instructions;
        assert.ok(text.startsWith('Source hierarchy (required): (1) WHOOP measurements are authoritative'),'first 512 characters carry the hierarchy');
        for(const rule of SOURCE_HIERARCHY)assert.ok(text.includes(rule));
        for(const re of RULE_WORDS)assert.match(text,re);
        assert.doesNotMatch(text,SUBSTITUTION);
        assert.match(init.result.serverInfo.description,/authoritative WHOOP.*supplementary.*never substituted/);
      }
    }finally{db.close();}
  });

  test(`[${version}] tools/list: WHOOP tools are authoritative, integrations supplementary, medical context user-directed`,async()=>{
    const db=await fixture();try{
      const tools=(await rpc(db,'tools/list',{})).result.tools;
      const by=Object.fromEntries(tools.map(t=>[t.name,t]));
      for(const n of ['get_profile','get_body_measurements','get_recovery','get_sleep','get_workouts','get_cycles']){
        assert.match(by[n].description,/Authoritative WHOOP measurements \(source "whoop"\); if they are missing or stale, say so and never fill the gap from another source\./);
        assert.equal(by[n].annotations.readOnlyHint,true);
      }
      for(const n of ['get_health_connect','get_samsung_health'])
        assert.match(by[n].description,/Supplementary: cite them as (Health Connect|Samsung Health), never as WHOOP data or a substitute for missing WHOOP measurements\./);
      assert.match(by.get_medical_context.description,/only when the user asks for it; never as a substitute for WHOOP measurements/);
      for(const t of tools)assert.doesNotMatch(t.description,SUBSTITUTION);
    }finally{db.close();}
  });

  test(`[${version}] tools/call: WHOOP results carry source, authority and missing/stale flags in text and structuredContent`,async()=>{
    const db=await fixture();try{
      const fresh=new Date(Date.now()-3600e3).toISOString(),old=new Date(Date.now()-72*3600e3).toISOString();
      const cases=[
        [{records:[],next_token:null},{records_returned:0,missing:true,latest_record_at:null,stale:true}],
        [{records:[{created_at:fresh,score:{recovery_score:55}}],next_token:null},{records_returned:1,missing:false,latest_record_at:new Date(Date.parse(fresh)).toISOString(),stale:false}],
        [{records:[{created_at:old,score:{recovery_score:55}}],next_token:null},{records_returned:1,missing:false,latest_record_at:new Date(Date.parse(old)).toISOString(),stale:true}]
      ];
      for(const [page,flags] of cases){
        const r=out(await rpc(db,'tools/call',{name:'get_recovery',arguments:{limit:5}},ENV,async()=>page));
        for(const v of [r.text,...(r.structured?[r.structured]:[])]){
          assert.equal(v.source,'whoop');assert.equal(v.source_authority,'authoritative');
          assert.deepEqual(v.whoop_measurements,flags);
          // The server never fills a missing WHOOP result from another source.
          assert.doesNotMatch(JSON.stringify(v),/health_connect|samsung/);
        }
      }
      // Workouts are irregular, so no stale judgement; profile gets the source label.
      const w=out(await rpc(db,'tools/call',{name:'get_workouts',arguments:{}},ENV,async()=>({records:[],next_token:null}))).text;
      assert.deepEqual(w.whoop_measurements,{records_returned:0,missing:true,latest_record_at:null});
      const p=out(await rpc(db,'tools/call',{name:'get_profile',arguments:{}},ENV,async()=>({first_name:'Synthetic'}))).text;
      assert.equal(p.source,'whoop');assert.equal(p.source_authority,'authoritative');
    }finally{db.close();}
  });

  test(`[${version}] tools/call: supplementary and user-directed sources keep their own labels; capabilities return the hierarchy`,async()=>{
    const db=await fixture();try{
      const hc=out(await rpc(db,'tools/call',{name:'get_health_connect',arguments:{}})).text;
      assert.equal(hc.source,'health_connect');assert.equal(hc.source_authority,'supplementary');
      const sh=out(await rpc(db,'tools/call',{name:'get_samsung_health',arguments:{}})).text;
      assert.equal(sh.source,'samsung_health');assert.equal(sh.source_authority,'supplementary');
      const mc=out(await rpc(db,'tools/call',{name:'get_medical_context',arguments:{}})).text;
      assert.equal(mc.source_authority,'user_directed');
      const cap=out(await rpc(db,'tools/call',{name:'get_capabilities',arguments:{}})).text;
      assert.deepEqual(cap.source_hierarchy,[...SOURCE_HIERARCHY]);
    }finally{db.close();}
  });
}

test('guidance text contains each rule once and never recommends substituting sources',()=>{
  assert.equal(SOURCE_HIERARCHY.length,6);
  for(const re of RULE_WORDS)assert.equal(SOURCE_HIERARCHY.filter(r=>re.test(r)).length,1);
  for(const text of [hostInstructions,memberGuidance,...SOURCE_HIERARCHY])assert.doesNotMatch(text,SUBSTITUTION);
});
