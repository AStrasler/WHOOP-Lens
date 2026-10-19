// End-to-end member isolation after the guidance (#68) and diagnostics (#69)
// changes: authenticated D1 journaling (flare_consent and the journal tools),
// cross-member reads and writes, and the new diagnostics and report tables,
// all through the router with the synthetic identity header. Synthetic members
// only; every migration is applied, including 0017.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {connect} from './audit-fixtures.mjs';
import {createStagingRouter} from '../src/router.mjs';

const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const AMYLIKE='0b0b0b0b-0000-4000-8000-00000000000b';
const KIMLIKE='0c0c0c0c-0000-4000-8000-00000000000c';
const OUTSIDER='0e0e0e0e-0000-4000-8000-00000000000e';
const BASE={MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',FLARE_JOURNAL_ENABLED:'true'};
const FULL={...BASE,ISSUE_REPORTS_ENABLED:'true',DIAGNOSTICS_CAPTURE_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
const {AccessDenied}=await import('../src/access-denied.mjs');

async function fixture(members){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  for(const id of [...members,OUTSIDER]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,id===OUTSIDER?0:1);
  }
  for(const id of members)await connect(sqlite,id,id===OWNER?'developer':'public','access-'+id);
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
const router=createStagingRouter({verifyIdentity:async req=>{
  const who=req.headers.get('x-synthetic-member');
  if(!who)throw new AccessDenied(401);
  return who;
}});
async function rpc(db,env,who,method,params){
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
  if(who)headers['x-synthetic-member']=who;
  const res=await router(new Request('https://whooplens.tech/mcp',{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{...env,DB:db});
  return {status:res.status,body:await res.json()};
}
// Returns the parsed tool result, or {error} for a protocol or tool error.
async function tool(db,env,who,name,args={}){
  const r=await rpc(db,env,who,'tools/call',{name,arguments:args});
  if(r.status!==200)return {error:'http_'+r.status};
  if(r.body.error)return {error:r.body.error.message};
  const t=r.body.result.content[0].text;
  if(r.body.result.isError)return {error:t};
  return JSON.parse(t);
}
const consent={storage_consent:'store-flare-journal'};
const marker=id=>'Synthetic condition '+id.slice(0,2);
const entryFor=(id,severity)=>({date:'2026-10-01',flare:'yes',severity,symptoms:['marker '+id.slice(0,2)],notes:'Private note '+id.slice(0,2)});

async function journalScenario(db,env,members){
  // Each member opts in and writes distinct context and entries.
  for(const [i,id] of members.entries()){
    assert.ok(!(await tool(db,env,id,'set_flare_consent',consent)).error,'consent '+id);
    assert.ok(!(await tool(db,env,id,'save_flare_context',{conditions:[marker(id)]})).error);
    assert.ok(!(await tool(db,env,id,'save_flare_entry',entryFor(id,i+1))).error);
  }
  // Each sees only their own journal.
  const journals={};
  for(const [i,id] of members.entries()){
    const j=await tool(db,env,id,'get_flare_journal');
    journals[id]=j;
    assert.equal(j.entries.length,1);assert.equal(j.entries[0].severity,i+1);
    const dump=JSON.stringify(j);
    for(const other of members)if(other!==id){
      assert.ok(!dump.includes(marker(other))&&!dump.includes('Private note '+other.slice(0,2))&&!dump.includes(other),id+' sees '+other);
    }
  }
  const [a,b]=members;
  // A client-supplied member id is rejected, never honored.
  for(const name of ['get_flare_journal','save_flare_entry','set_flare_consent','withdraw_flare_journal'])
    assert.equal((await tool(db,env,b,name,{user_id:a,...(name==='save_flare_entry'?entryFor(a,9):{}),...(name==='set_flare_consent'?consent:{}),...(name==='withdraw_flare_journal'?{confirm:'delete-my-flare-journal'}:{})})).error,'Invalid tool arguments',name);
  // Another member's revision cannot edit or delete their entry: it only targets b's own rows.
  const aRev=journals[a].entries[0].revision;
  await tool(db,env,b,'save_flare_entry',{...entryFor(b,9),expected_revision:aRev});
  await tool(db,env,b,'delete_flare_entry',{entry_key:'2026-10-01',expected_revision:aRev,confirm:'delete-flare-entry'});
  const aAfter=await tool(db,env,a,'get_flare_journal');
  assert.equal(aAfter.entries[0].severity,1);assert.equal(aAfter.entries[0].revision,aRev);
  // Withdrawal by b deletes only b's journal and consent.
  assert.ok(!(await tool(db,env,b,'withdraw_flare_journal',{confirm:'delete-my-flare-journal'})).error);
  assert.equal((await tool(db,env,b,'get_flare_journal')).entries.length,0);
  for(const id of members)if(id!==b)assert.equal((await tool(db,env,id,'get_flare_journal')).entries.length,1,id+' kept');
  const consentRows=Object.fromEntries(db.sqlite.prepare('SELECT user_id,storage FROM flare_consent').all().map(r=>[r.user_id,r.storage]));
  for(const id of members)assert.equal(consentRows[id]??0,id===b?0:1,'flare_consent '+id);
  // Inactive members and unauthenticated callers get nothing and change nothing.
  const before=db.sqlite.prepare('SELECT COUNT(*) n FROM flare_journal').get().n;
  assert.equal((await rpc(db,env,OUTSIDER,'tools/call',{name:'set_flare_consent',arguments:consent})).status,403);
  assert.equal((await rpc(db,env,null,'tools/call',{name:'get_flare_journal',arguments:{}})).status,401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM flare_journal').get().n,before);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM flare_consent WHERE user_id=?').get(OUTSIDER).n,0);
}

test('two members: journaling and consent stay isolated with diagnostics and reports off',async()=>{
  const db=await fixture([AMYLIKE,KIMLIKE]);try{
    await journalScenario(db,BASE,[AMYLIKE,KIMLIKE]);
    // With the new features off, their tables stay empty and their tools are absent.
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM diagnostic_events').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM issue_reports').get().n,0);
    const listed=(await rpc(db,BASE,AMYLIKE,'tools/list',{})).body.result.tools.map(t=>t.name);
    assert.ok(listed.includes('save_flare_entry')&&!listed.includes('report_issue')&&!listed.includes('review_issue_reports'));
  }finally{db.close();}
});

test('three members with owner, diagnostics and reports on: journaling, reports and diagnostics stay isolated',async()=>{
  const members=[OWNER,AMYLIKE,KIMLIKE];
  const db=await fixture(members);try{
    await journalScenario(db,FULL,members);
    // Failures are captured per authenticated member.
    await tool(db,FULL,AMYLIKE,'get_flare_journal',{user_id:KIMLIKE});
    await tool(db,FULL,KIMLIKE,'save_flare_entry',{date:'2026-02-30',flare:'yes'});
    // Amy files a report; Kim cannot reuse Amy's approval token or see Amy's report.
    const args={category:'unavailable_data',description:'My journal page looked empty once'};
    const preview=await tool(db,FULL,AMYLIKE,'report_issue',args);
    assert.equal(preview.submitted,false);
    const stolen=await tool(db,FULL,KIMLIKE,'report_issue',{...args,approved:true});
    assert.ok(stolen.error&&/not submitted/.test(stolen.error));
    const amy=await tool(db,FULL,AMYLIKE,'report_issue',{...args,approved:true});
    assert.equal(amy.submitted,true);assert.match(amy.reference,/^WL-/);
    const kimPreview=await tool(db,FULL,KIMLIKE,'report_issue',{category:'other',description:'Charts did not load for me'});
    const kim=await tool(db,FULL,KIMLIKE,'report_issue',{category:'other',description:'Charts did not load for me',approved:true});
    assert.equal(kim.submitted,true);
    // Each report's evidence holds only its own member's diagnostics.
    const stored=db.sqlite.prepare('SELECT user_id,evidence_json,description FROM issue_reports').all();
    const ev=Object.fromEntries(stored.map(r=>[r.user_id,r.evidence_json]));
    const ridsOf=id=>db.sqlite.prepare('SELECT request_id FROM diagnostic_events WHERE user_key=?').all(id).map(r=>r.request_id);
    const evidenceRids=id=>JSON.parse(ev[id]).map(e=>e.request_id).filter(Boolean);
    assert.ok(evidenceRids(KIMLIKE).length>0&&evidenceRids(AMYLIKE).length>0,'each report carries its own evidence');
    for(const [me,other] of [[KIMLIKE,AMYLIKE],[AMYLIKE,KIMLIKE]]){
      assert.ok(evidenceRids(me).every(r=>ridsOf(me).includes(r)),me+' evidence is its own');
      assert.ok(!evidenceRids(me).some(r=>ridsOf(other).includes(r)),me+' evidence excludes '+other);
    }
    // Members have no owner tools; owner review shows pseudonymous tags only.
    for(const id of [AMYLIKE,KIMLIKE]){
      assert.match((await tool(db,FULL,id,'review_issue_reports')).error,/Unknown tool/);
      assert.match((await tool(db,FULL,id,'update_issue_report',{reference:amy.reference,status:'resolved'})).error,/Unknown tool/);
    }
    const review=await tool(db,FULL,OWNER,'review_issue_reports',{limit:10});
    assert.equal(review.reports.length,2);
    const tags=new Set(review.reports.map(r=>r.member_ref));
    assert.equal(tags.size,2);
    const reviewDump=JSON.stringify(review);
    for(const id of members)assert.ok(!reviewDump.includes(id),'no account ids in owner review');
    // No journal content anywhere in the new tables or the owner's view.
    const newTables=JSON.stringify([db.sqlite.prepare('SELECT * FROM diagnostic_events').all(),stored]);
    for(const id of members)for(const s of [marker(id),'Private note '+id.slice(0,2),'marker '+id.slice(0,2)]){
      assert.ok(!newTables.includes(s)&&!reviewDump.includes(s),s);
    }
    // Diagnostic rows are bound to the authenticated caller, never to an injected id.
    const keys=db.sqlite.prepare("SELECT user_key,code FROM diagnostic_events WHERE code='invalid_arguments'").all();
    assert.ok(keys.length>=2&&keys.every(k=>[AMYLIKE,KIMLIKE].includes(k.user_key)));
    assert.ok(keys.some(k=>k.user_key===AMYLIKE)&&keys.some(k=>k.user_key===KIMLIKE));
  }finally{db.close();}
});
