// Retention must not depend on member activity: the scheduled handler runs the
// same bounded cleanup as capture(). Synthetic rows only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {runRetention,RETENTION_DAYS,REPORT_RETENTION_DAYS,SCHEDULED_ROUNDS} from '../src/diagnostics.mjs';

const DIR=new URL('../migrations/',import.meta.url);
const NOW=Date.parse('2026-10-25T12:00:00Z'),DAY=86400000;
const iso=ms=>new Date(ms).toISOString();
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(f,DIR),'utf8'));
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
function event(db,i,lastAt){
  db.sqlite.prepare("INSERT INTO diagnostic_events(user_key,category,subsystem,code,outcome,retryable,bucket,count,first_at,last_at,request_id) VALUES(?,'auth','mcp','unauthenticated','fail',0,?,1,?,?,'req_0011223344556677')")
    .run('',i,lastAt,lastAt);
}
const MEMBER='0b0b0b0b-0000-4000-8000-00000000000b';
function report(db,ref,status,updatedAt){
  db.sqlite.prepare("INSERT OR IGNORE INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(MEMBER,MEMBER);
  db.sqlite.prepare("INSERT INTO issue_reports(reference,user_id,category,severity,status,description,dedupe_key,request_id,evidence_json,day_key,last_submitted_at,created_at,updated_at) VALUES(?,?,'other','low',?,'Synthetic',?,'req_0011223344556677','[]','2026-01-01',?,?,?)")
    .run(ref,MEMBER,status,ref.toLowerCase().replace(/[^a-z0-9]/g,'0').padEnd(64,'a').slice(0,64).replace(/[^0-9a-f]/g,'a'),updatedAt,updatedAt,updatedAt);
}
const count=(db,t)=>db.sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

test('scheduled retention removes only rows past retention, with no member activity',async()=>{
  const db=fixture();try{
    event(db,1,iso(NOW-(RETENTION_DAYS+1)*DAY));
    event(db,2,iso(NOW-(RETENTION_DAYS-1)*DAY));
    report(db,'WL-OLDRES01','resolved',iso(NOW-(REPORT_RETENTION_DAYS+1)*DAY));
    report(db,'WL-NEWRES01','resolved',iso(NOW-10*DAY));
    report(db,'WL-OLDOPEN1','new',iso(NOW-(REPORT_RETENTION_DAYS+30)*DAY));
    const r=await runRetention(db,{now:NOW});
    assert.deepEqual(r,{deleted:2,ok:true});
    assert.equal(count(db,'diagnostic_events'),1);
    assert.deepEqual(db.sqlite.prepare('SELECT reference FROM issue_reports ORDER BY reference').all().map(x=>x.reference),['WL-NEWRES01','WL-OLDOPEN1'],'unresolved reports are kept');
  }finally{db.close();}
});

test('scheduled retention drains a backlog beyond one bounded batch, and stops',async()=>{
  const db=fixture();try{
    for(let i=0;i<120;i++)event(db,i,iso(NOW-(RETENTION_DAYS+5)*DAY));
    assert.deepEqual(await runRetention(db,{now:NOW}),{deleted:120,ok:true});
    assert.equal(count(db,'diagnostic_events'),0);
    let batches=0;const counting={...db,batch:s=>{batches++;return db.batch(s);}};
    await runRetention(counting,{now:NOW});
    assert.equal(batches,1,'nothing left: one round then stop');
    let calls=0;const endless={prepare:()=>({bind(){return this;}}),batch:async s=>{calls++;return s.map(()=>({meta:{changes:1}}));}};
    await runRetention(endless,{now:NOW});
    assert.equal(calls,SCHEDULED_ROUNDS,'bounded rounds');
  }finally{db.close();}
});

test('scheduled retention fails closed without a database or on errors',async()=>{
  assert.deepEqual(await runRetention(undefined),{deleted:0,ok:false});
  assert.deepEqual(await runRetention({prepare:()=>({bind(){return this;}}),batch:async()=>{throw Error('D1 down');}}),{deleted:0,ok:false});
});
