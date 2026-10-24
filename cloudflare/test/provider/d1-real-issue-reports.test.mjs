// Issue reports against real Cloudflare D1 (Miniflare/workerd), not node:sqlite.
// D1 enforces limits that local SQLite does not (for example LIKE/GLOB
// patterns of at most 50 bytes), so the submit path must run here too.
// Synthetic members only. Runs after `npm ci` (Miniflare ships with wrangler).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {reportIssue,reviewIssueReports} from '../../src/issue-reports.mjs';
import {newRequestId} from '../../src/diagnostics.mjs';

const DIR=new URL('../../migrations/',import.meta.url);
const MIGRATIONS=readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort();
const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const MEMBER='0b0b0b0b-0000-4000-8000-00000000000b';
const ENV={ISSUE_REPORTS_ENABLED:'true',DIAGNOSTICS_CAPTURE_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
// D1 exec() takes one statement per line.
const oneLine=sql=>sql.replace(/--[^\n]*/g,'').replace(/\s*\n\s*/g,' ').trim();

async function realD1(upTo){
  const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response("")}}',d1Databases:{DB:'issue-reports-'+Date.now()+Math.random()}});
  const db=await mf.getD1Database('DB');
  for(const f of MIGRATIONS){if(upTo&&f>upTo)break;await db.exec(oneLine(readFileSync(new URL(f,DIR),'utf8')));}
  for(const id of [OWNER,MEMBER]){
    await db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?1,'cloudflare_access',?1)").bind(id).run();
    await db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?1,1)').bind(id).run();
  }
  return {db,close:()=>mf.dispose()};
}

test('real D1: an approved report is stored and returns a reference',async()=>{
  const {db,close}=await realD1();
  try{
    const args={category:'other',description:'Charts stay blank after sync'};
    const preview=await reportIssue(db,MEMBER,args,{requestId:newRequestId(),env:ENV});
    assert.equal(preview.approval_required,true);
    const done=await reportIssue(db,MEMBER,{...args,approved:true},{requestId:newRequestId(),env:ENV});
    assert.equal(done.submitted,true);
    assert.match(done.reference,/^WL-[A-Z0-9]{8}$/);
    const owner=await reviewIssueReports(db,OWNER,{},{env:ENV});
    assert.deepEqual(owner.reports.map(r=>r.reference),[done.reference]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM issue_report_approvals').first()).n,0);
  }finally{await close();}
});

test('real D1: modified text is refused with the earlier approval and nothing is stored',async()=>{
  const {db,close}=await realD1();
  try{
    const args={category:'other',description:'Charts stay blank after sync'};
    const preview=await reportIssue(db,MEMBER,args,{requestId:newRequestId(),env:ENV});
    await assert.rejects(reportIssue(db,MEMBER,{...args,description:'CHARTS STAY BLANK AFTER SYNC',approved:true},{requestId:newRequestId(),env:ENV}),/fresh preview/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM issue_reports').first()).n,0);
  }finally{await close();}
});

test('real D1: approval without a token works across separate calls; other member, replay and expiry are refused',async()=>{
  const {db,close}=await realD1();
  try{
    const OTHER='0c0c0c0c-0000-4000-8000-00000000000c';
    await db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?1,'cloudflare_access',?1)").bind(OTHER).run();
    await db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?1,1)').bind(OTHER).run();
    const t0=Date.now(),args={category:'backend_failure',description:'Report button says unavailable'};
    const preview=await reportIssue(db,MEMBER,args,{requestId:newRequestId(),env:ENV,now:t0});
    assert.equal(preview.approval_token,undefined);
    await assert.rejects(reportIssue(db,OTHER,{...args,approved:true},{requestId:newRequestId(),env:ENV,now:t0+1000}),/fresh preview/);
    await assert.rejects(reportIssue(db,MEMBER,{...args,approved:true},{requestId:newRequestId(),env:ENV,now:t0+600001}),/fresh preview/);
    // Resending the cleaned text shown to the member is the same exact text.
    const done=await reportIssue(db,MEMBER,{category:args.category,description:preview.sanitized_description,approved:true},{requestId:newRequestId(),env:ENV,now:t0+1000});
    assert.equal(done.submitted,true);
    await assert.rejects(reportIssue(db,MEMBER,{...args,approved:true},{requestId:newRequestId(),env:ENV,now:t0+70000}),/fresh preview/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM issue_reports').first()).n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM issue_report_approvals').first()).n,0);
  }finally{await close();}
});

test('real D1: the 0017 reference CHECK alone rejects every insert; 0018 accepts valid and rejects invalid references',async()=>{
  const row="INSERT INTO issue_reports(reference,user_id,category,severity,description,dedupe_key,request_id,evidence_json,day_key,last_submitted_at,created_at,updated_at) "+
    "VALUES(?1,?2,'other','low','synthetic text','"+'a'.repeat(64)+"','req_0000000000000000','[]','2026-10-19','t','t','t')";
  const at17=await realD1('0017_member_diagnostics.sql');
  try{
    await assert.rejects(at17.db.prepare(row).bind('WL-ABCD2345',MEMBER).run(),/pattern too complex/);
  }finally{await at17.close();}
  const {db,close}=await realD1();
  try{
    await db.prepare(row).bind('WL-ABCD2345',MEMBER).run();
    for(const bad of ['WL-abcd2345','WL-ABCD234','WL-ABCD23456','XX-ABCD2345','WL-ABCD-345'])
      await assert.rejects(db.prepare(row).bind(bad,MEMBER).run(),/CHECK constraint/,bad);
  }finally{await close();}
});

test('real D1: the 0018 rollback succeeds with stored reports and keeps them',async()=>{
  const {db,close}=await realD1();
  try{
    await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)");
    await db.prepare('INSERT INTO d1_migrations(name) VALUES(?1)').bind('0018_issue_report_reference_check.sql').run();
    const args={category:'other',description:'Charts stay blank after sync'};
    const preview=await reportIssue(db,MEMBER,args,{requestId:newRequestId(),env:ENV});
    const done=await reportIssue(db,MEMBER,{...args,approved:true},{requestId:newRequestId(),env:ENV});
    await db.exec(oneLine(readFileSync(new URL('../../migration/rollback/0018_issue_report_reference_check.down.sql',import.meta.url),'utf8')));
    assert.equal((await db.prepare('SELECT reference FROM issue_reports').first()).reference,done.reference);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM d1_migrations WHERE name='0018_issue_report_reference_check.sql'").first()).n,0);
  }finally{await close();}
});
