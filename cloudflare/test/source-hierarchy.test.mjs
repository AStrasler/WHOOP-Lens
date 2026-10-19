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
  /Ground every interpretation in measurements retrieved.*separate from hypotheses/,/missing or stale.*Never silently fill the gap/,/required, not an optional recommendation.*Only the user decides/,
  /User-entered WHOOP records.*authoritative records of what the person reported.*Do not dispute, dismiss or demand verification.*never silently correct, overwrite, reinterpret or discard.*only when the origin is explicit.*entry_origin is unknown, keep it unknown and do not infer origin.*keep both.*without automatically favoring the sensor.*only with specific evidence/,
  /sensor measurements establish what WHOOP measured, manual entries establish what the person recorded, and user-provided context establishes what the person reports experiencing/];
const O={entry_origin:'unknown',entry_origin_note:'The WHOOP API does not mark records as user-entered or sensor-generated. Records are passed through unmodified; nap is WHOOP\'s own field.'};
const AUTO_HEALTH=/consult Health when relevant|do not finalize after retrieving WHOOP alone|call the Health connection in this request and check relevant dated records before answering;(?! prior)|always (call|check|consult) (ChatGPT |Apple )?Health/i;
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
        // External sources (ChatGPT Health) are consulted only when the user asks.
        assert.doesNotMatch(text,/consult Health when relevant|do not finalize after retrieving WHOOP alone/);
        assert.match(text,/offer to include them, and only when the user asks for Health data call the Health connection/);
        assert.match(text,/consult Health only when the user asks for it/);
        assert.match(text,/WHOOP Lens's own instructions; the AI host platform may have separate requirements of its own, which WHOOP Lens cannot override/);
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
        assert.match(by[n].description,/Every record is returned exactly as WHOOP provides it and is an authoritative WHOOP record whatever its origin; WHOOP does not say which records the person entered, so keep entry_origin unknown unless the person says so\./);
        // Naps are never presented as user-entered.
        assert.doesNotMatch(by[n].description,/user-entered[^.;]*nap|nap[^.;]*user-entered/i);
        assert.equal(by[n].annotations.readOnlyHint,true);
      }
      for(const n of ['get_health_connect','get_samsung_health'])
        assert.match(by[n].description,/Supplementary: cite them as (Health Connect|Samsung Health), never as WHOOP data or a substitute for missing WHOOP measurements\./);
      assert.match(by.get_medical_context.description,/only when the user asks for it; never as a substitute for WHOOP measurements/);
      for(const t of tools)assert.doesNotMatch(t.description,SUBSTITUTION);
      // No client-facing text tells a client to consult external Health records automatically.
      const cap=out(await rpc(db,'tools/call',{name:'get_capabilities',arguments:{include_planned:true,limit:25}})).text;
      const fixture=readFileSync(new URL('./fixtures/host-instructions-main.txt',import.meta.url),'utf8');
      for(const surface of [JSON.stringify(tools),JSON.stringify(cap),fixture])
        assert.doesNotMatch(surface,AUTO_HEALTH);
    }finally{db.close();}
  });

  test(`[${version}] tools/call: WHOOP results carry source, authority and missing/stale flags in text and structuredContent`,async()=>{
    const db=await fixture();try{
      const fresh=new Date(Date.now()-3600e3).toISOString(),old=new Date(Date.now()-72*3600e3).toISOString();
      const cases=[
        [{records:[],next_token:null},{...O,records_returned:0,missing:true,records_status:'none_in_range',latest_record_at:null,stale:true}],
        [{records:[{created_at:fresh,score:{recovery_score:55}}],next_token:null},{...O,records_returned:1,missing:false,records_status:'records_returned',latest_record_at:new Date(Date.parse(fresh)).toISOString(),stale:false}],
        [{records:[{created_at:old,score:{recovery_score:55}}],next_token:null},{...O,records_returned:1,missing:false,records_status:'records_returned',latest_record_at:new Date(Date.parse(old)).toISOString(),stale:true}]
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
      assert.deepEqual(w.whoop_measurements,{...O,records_returned:0,missing:true,records_status:'none_in_range',latest_record_at:null});
      const p=out(await rpc(db,'tools/call',{name:'get_profile',arguments:{}},ENV,async()=>({first_name:'Synthetic'}))).text;
      assert.equal(p.source,'whoop');assert.equal(p.source_authority,'authoritative');
    }finally{db.close();}
  });

  test(`[${version}] tools/call: manual sleep, naps, manual activities and manual-vs-sensor conflicts are all returned unmodified`,async()=>{
    const db=await fixture();try{
      const t=h=>new Date(Date.now()-h*3600e3).toISOString();
      // Synthetic. The WHOOP API has no manual marker, so these differ only in the fields WHOOP does return.
      const manualSleep={id:'aaaaaaaa-0000-4000-8000-000000000001',cycle_id:1,start:t(30),end:t(22),nap:false,score_state:'UNSCORABLE'};
      const nap={id:'aaaaaaaa-0000-4000-8000-000000000002',cycle_id:2,start:t(6),end:t(5),nap:true,score_state:'SCORED',score:{stage_summary:{total_in_bed_time_milli:3600000}}};
      // Conflict: the person logged 8h in bed; the sensor scored an overlapping 5h sleep. Both stay.
      const sensorSleep={id:'aaaaaaaa-0000-4000-8000-000000000003',cycle_id:1,start:t(28),end:t(23),nap:false,score_state:'SCORED',score:{stage_summary:{total_in_bed_time_milli:18000000}}};
      const page={records:[nap,manualSleep,sensorSleep],next_token:null};
      const frozen=JSON.parse(JSON.stringify(page.records));
      const r=await rpc(db,'tools/call',{name:'get_sleep',arguments:{}},ENV,async()=>page);
      for(const v of [out(r).text,...(out(r).structured?[out(r).structured]:[])]){
        assert.deepEqual(v.records,frozen,'every record, in WHOOP order, with original values');
        assert.equal(v.whoop_measurements.records_returned,3);assert.equal(v.whoop_measurements.naps_returned,1);
        assert.equal(v.whoop_measurements.entry_origin,'unknown');
      }
      const manualActivity={id:'bbbbbbbb-0000-4000-8000-000000000001',start:t(50),end:t(49),sport_name:'yoga',score_state:'SCORED',score:{strain:4.1,percent_recorded:0}};
      const sensorActivity={id:'bbbbbbbb-0000-4000-8000-000000000002',start:t(50),end:t(49.5),sport_name:'activity',score_state:'SCORED',score:{strain:6.3,percent_recorded:100}};
      const w=out(await rpc(db,'tools/call',{name:'get_workouts',arguments:{}},ENV,async()=>({records:[manualActivity,sensorActivity],next_token:null}))).text;
      assert.deepEqual(w.records,[manualActivity,sensorActivity]);
      assert.equal(w.whoop_measurements.records_returned,2);
      // Origin is never inferred: naps, unscored records, odd shapes, even a non-WHOOP
      // "manual" key all stay unknown, because WHOOP v2 has no provenance field.
      const odd=[{id:'c1',nap:true,score_state:'PENDING_SCORE'},{id:'c2',score_state:'UNSCORABLE'},{id:'c3'},{},{id:'c5',manual:true,source:'user'},{id:'c6',score:{percent_recorded:0}}];
      for(const tool of ['get_sleep','get_workouts','get_cycles','get_recovery']){
        const o=out(await rpc(db,'tools/call',{name:tool,arguments:{}},ENV,async()=>({records:odd.map(r=>({...r})),next_token:null}))).text;
        assert.equal(o.whoop_measurements.entry_origin,'unknown');
        assert.deepEqual(o.records,odd,'records unchanged');
        for(const r of o.records)assert.equal(Object.hasOwn(r,'entry_origin'),false,'no per-record guess');
      }
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
  assert.equal(SOURCE_HIERARCHY.length,8);
  for(const re of RULE_WORDS)assert.equal(SOURCE_HIERARCHY.filter(r=>re.test(r)).length,1);
  for(const text of [hostInstructions,memberGuidance,...SOURCE_HIERARCHY])assert.doesNotMatch(text,SUBSTITUTION);
});

// Edge cases in attributeWhoop (final review of PR #72).
test('timestamp fallback uses the first valid of end, start, created_at',async()=>{
  const {attributeWhoop}=await import('../src/mcp.mjs');
  const now=Date.parse('2026-10-19T12:00:00Z'),v='2026-10-19T10:00:00.000Z',v2='2026-10-18T10:00:00.000Z';
  const cases=[[{end:'',start:v},v],[{end:'garbage',start:v},v],[{end:null,start:'',created_at:v},v],[{end:'x',start:'y',created_at:v},v],
    [{start:v},v],[{created_at:v},v],[{end:v2,start:v},v2],[{end:42,start:v},v],[{end:'',start:'',created_at:''},null],[{},null]];
  for(const [r,want] of cases){
    const out=attributeWhoop({records:[r],next_token:null,complete:true},'get_sleep',true,now);
    assert.equal(out.whoop_measurements.latest_record_at,want,JSON.stringify(r));
    assert.deepEqual(out.records,[r],'record unchanged');
  }
  assert.equal(attributeWhoop({records:[{end:'bad',start:v}],complete:true},'get_sleep',true,now).whoop_measurements.stale,false);
});

test('an empty page is "no records" only on a complete first page',async()=>{
  const {attributeWhoop}=await import('../src/mcp.mjs');
  const now=Date.parse('2026-10-19T12:00:00Z');
  const m=(d,first)=>attributeWhoop(d,'get_recovery',first,now).whoop_measurements;
  let x=m({records:[],next_token:null,complete:true},true);
  assert.equal(x.missing,true);assert.equal(x.records_status,'none_in_range');assert.equal(x.stale,true);
  x=m({records:[],next_token:'sealed',complete:false},true);
  assert.equal(x.missing,false);assert.equal(x.records_status,'empty_page_more_may_exist');assert.equal(x.stale,null);assert.equal(x.stale_reason,'page_incomplete');
  x=m({records:[],next_token:null,complete:false,incomplete_reason:'page_limit'},true);
  assert.equal(x.missing,false);assert.equal(x.records_status,'empty_page_more_may_exist');
  x=m({records:[],next_token:null,complete:true},false);
  assert.equal(x.missing,false);assert.equal(x.records_status,'continuation_page_empty');assert.equal(Object.hasOwn(x,'stale'),false);
  x=m({records:[],next_token:'sealed',complete:false},false);
  assert.equal(x.missing,false);assert.equal(x.records_status,'empty_page_more_may_exist');
  // Existing pagination fields are unchanged.
  const page={records:[],next_token:'sealed',complete:false};
  const out=attributeWhoop(page,'get_recovery',true,now);
  assert.equal(out.next_token,'sealed');assert.equal(out.complete,false);assert.deepEqual(out.records,[]);
});

test('a WHOOP fetch error is an error, never reported as missing data',async()=>{
  const {handleMcpRpc,validateMcpTransport}=await import('../src/mcp.mjs');
  const db=await fixture();try{
    const t=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
    const r=await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_recovery',arguments:{}}},
      {db,userId:MEMBER,env:ENV,whoopRequest:async()=>{throw Error('WHOOP 503');}},t);
    const body=JSON.stringify(r);
    assert.ok(r.result?.isError===true||r.error,'error result');
    assert.doesNotMatch(body,/whoop_measurements|"missing"|none_in_range/);
  }finally{db.close();}
});

test('history tools take no start/end window, so stale only ever applies to the latest first page',async()=>{
  const {handleMcpRpc,validateMcpTransport}=await import('../src/mcp.mjs');
  const db=await fixture();try{
    const t=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
    const call=a=>handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_sleep',arguments:a}},{db,userId:MEMBER,env:ENV,whoopRequest:async()=>({records:[],next_token:null})},t);
    for(const a of [{start:'2025-01-01T00:00:00Z'},{end:'2025-02-01T00:00:00Z'},{start:'2025-01-01T00:00:00Z',end:'2025-02-01T00:00:00Z'}])
      assert.equal((await call(a)).error?.message,'Invalid tool arguments');
    // Default (current) request: stale is computed.
    assert.equal(Object.hasOwn(JSON.parse((await call({})).result.content[0].text).whoop_measurements,'stale'),true);
  }finally{db.close();}
});
