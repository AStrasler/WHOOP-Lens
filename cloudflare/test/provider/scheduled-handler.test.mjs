// The resource worker's cron entry runs only the bounded retention cleanup.
import {registerHooks} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from '../d1-sqlite.mjs';
import {RETENTION_DAYS} from '../../src/diagnostics.mjs';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true};
  return next(specifier,context);
}});
const {default:resource}=await import('../../oauth/resource/src/index.mjs');
const DIR=new URL('../../migrations/',import.meta.url);
const NOW=Date.parse('2026-10-25T12:00:00Z');

test('scheduled handler runs retention via waitUntil and touches nothing else',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(f,DIR),'utf8'));
  const db={...d1Database(sqlite)};
  try{
    const old=new Date(NOW-(RETENTION_DAYS+1)*86400000).toISOString();
    sqlite.prepare("INSERT INTO diagnostic_events(user_key,category,subsystem,code,outcome,retryable,bucket,count,first_at,last_at,request_id) VALUES('','auth','mcp','unauthenticated','fail',0,1,1,?,?,'req_0011223344556677')").run(old,old);
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES('0b0b0b0b-0000-4000-8000-00000000000b','cloudflare_access','s')").run();
    sqlite.prepare("INSERT INTO whoop_members(user_id,active) VALUES('0b0b0b0b-0000-4000-8000-00000000000b',0)").run();
    const waits=[];
    resource.scheduled({scheduledTime:NOW,cron:'17 3 * * *'},{DB:db},{waitUntil:p=>waits.push(p)});
    assert.equal(waits.length,1);await Promise.all(waits);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM diagnostic_events').get().n,0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM whoop_members').get().n,1,'member rows are never touched');
    assert.doesNotThrow(()=>resource.scheduled({scheduledTime:NOW},{},{waitUntil:()=>assert.fail('no DB, no work')}));
  }finally{sqlite.close();}
});
