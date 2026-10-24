import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {runFlareTool,flareArguments,flareTools} from '../src/flare-journal.mjs';
import {analyzeFlarePatterns} from '../src/flare-patterns.mjs';
import {handleMcpRpc} from '../src/mcp.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function setup(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of ['0001_initial.sql','0013_flare_journal.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 for(const id of [A,B]){
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
  sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,'2030-01-01','synthetic','synthetic','v1','public')").run(id);
 }
 const db={...d1Database(sqlite),sqlite};
 const ctx={db,userId:A,env:{FLARE_JOURNAL_ENABLED:'true'},whoopRequest:async()=>({records:[],next_token:null})};
 return {db,ctx,call:(name,args={},id=A)=>runFlareTool(name,args,{...ctx,userId:id}),close:()=>sqlite.close()};
}
const opt={storage_consent:'store-flare-journal'};
const analyzed={...opt,analysis_consent:'analyze-flare-patterns'};
const entry={date:'2026-10-01',flare:'yes',severity:7,symptoms:['joint discomfort'],confounders:['poor sleep'],notes:'Synthetic only.'};
const range={start:'2026-10-01',end:'2026-10-03'};
function record(date,value,id=date){return {id,created_at:date+'T08:00:00Z',updated_at:date+'T09:00:00Z',score_state:'SCORED',score:{recovery_score:value,hrv_rmssd_milli:40,resting_heart_rate:60}};}

test('feature off hides every new tool and blocks direct calls',async()=>{
 const s=setup();try{
  s.ctx.env={};
  const rpc=(method,params)=>handleMcpRpc({jsonrpc:'2.0',id:1,method,params},s.ctx,{modern:true});
  const listed=await rpc('tools/list',{});assert.ok(!listed.result.tools.some(t=>t.name==='save_flare_entry'));
  assert.equal((await rpc('tools/call',{name:'set_flare_consent',arguments:opt})).error.code,-32602);
  await assert.rejects(s.call('set_flare_consent',opt));
  assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM flare_consent').get().n,0);
 }finally{s.close();}
});
test('strict schemas reject owner injection, invalid dates, notes, labels and broad analysis',()=>{
 for(const a of [{...entry,user_id:B},{...entry,date:'2026-02-30'},{...entry,severity:11},{...entry,flare:'predicted'},{...entry,notes:'x'.repeat(2001)},{...entry,symptoms:['x','x']},{...entry,expected_revision:42}])assert.equal(flareArguments('save_flare_entry',a),null);
 assert.equal(flareArguments('analyze_flare_patterns',{start:'2026-01-01',end:'2026-10-01'}),null);
 assert.equal(flareArguments('set_flare_consent',{storage_consent:'yes'}),null);
 assert.equal(flareArguments('get_flare_journal',{limit:51}),null);
 assert.ok(flareArguments('save_flare_entry',entry));
});
test('storage and analysis consent are independent; existing membership grants neither',async()=>{
 const s=setup();try{
  assert.deepEqual((await s.call('get_flare_journal')).consent,{storage:false,analysis:false});
  await assert.rejects(s.call('save_flare_entry',entry));
  await s.call('set_flare_consent',opt);
  await s.call('save_flare_entry',entry);
  await assert.rejects(s.call('analyze_flare_patterns',range));
  await s.call('set_flare_consent',analyzed);
  const out=await s.call('analyze_flare_patterns',range);
  assert.equal(out.warning.prediction_enabled,false);
  assert.equal(out.warning.message,'insufficient evidence for a flare warning');
  await s.call('pause_flare_analysis',{confirm:'pause-flare-analysis'});
  await assert.rejects(s.call('analyze_flare_patterns',range));
  assert.equal((await s.call('get_flare_journal')).entries.length,1);
 }finally{s.close();}
});
test('two accounts keep context, journal, edits, deletes and withdrawal separate',async()=>{
 const s=setup();try{
  for(const id of [A,B]){await s.call('set_flare_consent',analyzed,id);await s.call('save_flare_context',{conditions:[id===A?'Synthetic A':'Synthetic B']},id);await s.call('save_flare_entry',{...entry,severity:id===A?7:2},id);}
  const a=await s.call('get_flare_journal'),b=await s.call('get_flare_journal',{},B);
  assert.equal(a.entries[0].severity,7);assert.equal(b.entries[0].severity,2);
  assert.doesNotMatch(JSON.stringify(a),/Synthetic B/);
  await assert.rejects(s.call('save_flare_entry',{...entry,expected_revision:b.entries[0].revision}));
  await assert.rejects(s.call('delete_flare_entry',{entry_key:entry.date,expected_revision:b.entries[0].revision,confirm:'delete-flare-entry'}));
  await s.call('withdraw_flare_journal',{confirm:'delete-my-flare-journal'});
  assert.equal((await s.call('get_flare_journal')).entries.length,0);
  assert.equal((await s.call('get_flare_journal',{},B)).entries.length,1);
  assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM whoop_connections').get().n,2);
  await s.call('set_flare_consent',opt);
  assert.equal((await s.call('get_flare_journal')).context,null);
  assert.equal((await s.call('get_flare_journal')).consent.analysis,false);
 }finally{s.close();}
});
test('revision-controlled edits reject stale or missing revisions and cannot resurrect deleted entries',async()=>{
 const s=setup();try{
  await s.call('set_flare_consent',opt);const first=await s.call('save_flare_entry',entry);
  await assert.rejects(s.call('save_flare_entry',entry));
  const second=await s.call('save_flare_entry',{...entry,severity:3,expected_revision:first.revision});
  await assert.rejects(s.call('save_flare_entry',{...entry,expected_revision:first.revision}));
  assert.equal((await s.call('get_flare_journal')).entries[0].severity,3);
  await s.call('delete_flare_entry',{entry_key:entry.date,expected_revision:second.revision,confirm:'delete-flare-entry'});
  await assert.rejects(s.call('save_flare_entry',{...entry,expected_revision:second.revision}));
  assert.equal((await s.call('get_flare_journal')).entries.length,0);
 }finally{s.close();}
});
test('journal pagination has no duplicates and excludes context from date entries',async()=>{
 const s=setup();try{
  await s.call('set_flare_consent',opt);await s.call('save_flare_context',{conditions:[]});
  for(const date of ['2026-10-01','2026-10-02','2026-10-03'])await s.call('save_flare_entry',{date,flare:'unknown'});
  const a=await s.call('get_flare_journal',{limit:2});const b=await s.call('get_flare_journal',{limit:2,before:a.next_before});
  assert.deepEqual([...a.entries,...b.entries].map(e=>e.date),['2026-10-03','2026-10-02','2026-10-01']);assert.equal(b.next_before,null);
 }finally{s.close();}
});
test('membership changes and withdrawal during a write prevent journal mutation',async()=>{
 for(const change of ['member','withdraw']){
  const s=setup();try{
   await s.call('set_flare_consent',opt);
   const batch=s.db.batch;
   s.db.batch=async statements=>{
    if(change==='member')s.db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
    else s.db.sqlite.prepare("UPDATE flare_consent SET storage=0,analysis=0,generation='revoked' WHERE user_id=?").run(A);
    return batch(statements);
   };
   await assert.rejects(s.call('save_flare_entry',entry));
   assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM flare_journal').get().n,0);
  }finally{s.close();}
 }
});
test('withdrawal, pause, edit, membership loss and disconnect during history fetch suppress analysis',async()=>{
 for(const change of ['withdraw','pause','edit','member','disconnect','withdraw-reconsent']){
  const s=setup();try{
   await s.call('set_flare_consent',analyzed);await s.call('save_flare_entry',entry);
   let changed=false;
   s.ctx.whoopRequest=async()=>{
    if(!changed){changed=true;
     if(change.startsWith('withdraw')){await s.call('withdraw_flare_journal',{confirm:'delete-my-flare-journal'});if(change==='withdraw-reconsent')await s.call('set_flare_consent',analyzed);}
     else if(change==='pause')await s.call('pause_flare_analysis',{confirm:'pause-flare-analysis'});
     else if(change==='edit')await s.call('save_flare_entry',{date:'2026-10-02',flare:'no'});
     else if(change==='member')s.db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
     else s.db.sqlite.prepare('DELETE FROM whoop_connections WHERE user_id=?').run(A);
    }
    return {records:[],next_token:null};
   };
   await assert.rejects(s.call('analyze_flare_patterns',range),change);
  }finally{s.close();}
 }
});
test('partial source failure is reported and retried; raw medical notes never reach WHOOP',async()=>{
 const s=setup();try{
  await s.call('set_flare_consent',analyzed);await s.call('save_flare_entry',{...entry,notes:'SECRET SYNTHETIC NOTE'});
  let broken=true,attempts=0;
  s.ctx.whoopRequest=async(...args)=>{attempts++;assert.equal(args[1],A);assert.doesNotMatch(JSON.stringify(args.slice(1)),/SECRET SYNTHETIC/);if(broken)throw Error('Provider failed');return {records:[],next_token:null};};
  const a=await s.call('analyze_flare_patterns',range);assert.equal(a.evidence.retrieval_complete,false);
  broken=false;const b=await s.call('analyze_flare_patterns',range);assert.equal(b.evidence.retrieval_complete,true);assert.equal(attempts,6);
  assert.doesNotMatch(JSON.stringify(b),/SECRET SYNTHETIC/);
 }finally{s.close();}
});
test('descriptive comparisons preserve units, exact dates, missing labels and lag direction',async()=>{
 const calls=[];
 const out=await analyzeFlarePatterns([{date:'2026-10-02',flare:'yes',confounders:['travel']},{date:'2026-10-03',flare:'no'},{date:'2026-10-01',flare:'unknown'}],range,{userId:A,env:{},whoopRequest:async(_db,id,r,_env,q)=>{
  calls.push({id,r,q});return {records:r==='recovery'?[record('2026-10-01',20),record('2026-10-02',80),record('2026-10-03',60)]:[],next_token:null};
 }});
 const metric=out.metrics.find(m=>m.metric==='recovery_score');
 assert.equal(metric.unit,'score');assert.equal(metric.comparisons[0].mean_difference,20);
 assert.equal(metric.comparisons[1].mean_difference,-60);
 assert.deepEqual(metric.comparisons[1].paired_dates,[{label_date:'2026-10-02',measurement_date:'2026-10-01',label:'yes'},{label_date:'2026-10-03',measurement_date:'2026-10-02',label:'no'}]);
 assert.deepEqual(out.evidence.unknown_or_unlogged_dates,['2026-10-01']);
 assert.deepEqual(out.evidence.reported_confounder_days,['2026-10-02']);
 assert.ok(calls.every(c=>c.id===A&&c.q.start===(c.r==='sleep'?'2026-09-27T00:00:00Z':'2026-09-28T00:00:00Z')&&c.q.end==='2026-10-04T00:00:00Z'));
 assert.equal(out.warning.prediction_enabled,false);
});
test('duplicate, unscored, invalid, nap and open-cycle records cannot fabricate daily comparisons',async()=>{
 const out=await analyzeFlarePatterns([],range,{whoopRequest:async(_d,_u,r)=>({records:r==='recovery'?[record('2026-10-01',20,'same'),record('2026-10-01',20,'same'),record('2026-10-02',999),{...record('2026-10-03',80),score_state:'PENDING_SCORE'}]:r==='sleep'?[{id:1,start:'2026-09-30T23:00:00Z',end:'2026-10-01T08:00:00Z',nap:true,score_state:'SCORED',score:{sleep_performance_percentage:90}}]:[{id:2,start:'2026-10-01T08:00:00Z',end:null,score_state:'SCORED',score:{strain:10}}],next_token:null})});
 assert.equal(out.coverage.recovery.duplicate_records,1);
 assert.equal(out.metrics.find(m=>m.metric==='recovery_score').points.length,1);
 assert.equal(out.metrics.find(m=>m.metric==='strain').points.length,0);
 assert.equal(out.metrics.find(m=>m.metric==='sleep_performance_percentage').points.length,0);
 assert.ok(out.metrics.every(m=>m.comparisons.every(c=>c.mean_difference===null)));
});
test('MCP discovery, validation and execution preserve private tool annotations',async()=>{
 const s=setup();try{
  const rpc=(method,params)=>handleMcpRpc({jsonrpc:'2.0',id:1,method,params},s.ctx,{modern:true});
  const tools=(await rpc('tools/list',{})).result.tools;
  assert.equal(tools.filter(t=>flareTools.some(f=>f.name===t.name)).length,8);
  assert.equal(tools.find(t=>t.name==='withdraw_flare_journal').annotations.destructiveHint,true);
  assert.equal((await rpc('tools/call',{name:'set_flare_consent',arguments:{...opt,user_id:B}})).error.code,-32602);
  assert.equal((await rpc('tools/call',{name:'save_flare_entry',arguments:entry})).result.isError,true);
  assert.equal((await rpc('tools/call',{name:'set_flare_consent',arguments:opt})).result.structuredContent.storage,true);
  assert.equal((await rpc('tools/call',{name:'save_flare_entry',arguments:entry})).result.structuredContent.saved,true);
 }finally{s.close();}
});

test('analysis cannot label future or impossible dates as observed history',()=>{
 assert.equal(flareArguments('save_flare_entry',{...entry,date:'9999-12-31'}),null);
 assert.equal(flareArguments('analyze_flare_patterns',{start:'9999-12-29',end:'9999-12-31'}),null);
 assert.equal(flareArguments('analyze_flare_patterns',{start:'0000-01-01',end:'0000-01-03'}),null);
});
test('transaction failure rolls back the journal write and consent generation together',async()=>{
 const s=setup();try{
  await s.call('set_flare_consent',opt);
  const before=s.db.sqlite.prepare('SELECT generation FROM flare_consent WHERE user_id=?').get(A).generation;
  s.db.sqlite.exec("CREATE TRIGGER fail_generation BEFORE UPDATE ON flare_consent BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(s.call('save_flare_entry',entry));
  assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) n FROM flare_journal').get().n,0);
  assert.equal(s.db.sqlite.prepare('SELECT generation FROM flare_consent WHERE user_id=?').get(A).generation,before);
 }finally{s.close();}
});
test('analysis requests each account own records and never mixes their baselines',async()=>{
 const s=setup();try{
  for(const id of [A,B]){await s.call('set_flare_consent',analyzed,id);await s.call('save_flare_entry',entry,id);}
  s.ctx.whoopRequest=async(_d,id,r)=>({records:r==='recovery'?[record('2026-10-01',id===A?20:90)]:[],next_token:null});
  const a=await s.call('analyze_flare_patterns',range),b=await s.call('analyze_flare_patterns',range,B);
  assert.equal(a.metrics[0].personal_reference.mean,20);assert.equal(b.metrics[0].personal_reference.mean,90);
  assert.equal(s.db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%flare%cache%'").get().n,0);
 }finally{s.close();}
});
test('malformed pages, cyclic cursors and bounded pagination never assert complete history',async()=>{
 for(const mode of ['malformed','cycle','budget']){
  let calls=0;
  const out=await analyzeFlarePatterns([],range,{whoopRequest:async()=>{calls++;return mode==='malformed'?{error:'temporary'}:{records:[],next_token:mode==='cycle'?'repeat':String(calls)};}});
  assert.equal(out.evidence.retrieval_complete,false,mode);assert.ok(calls<=18);
 }
});
