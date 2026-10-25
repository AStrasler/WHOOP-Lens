// The former-member deletion runbook must name every table that stores a
// member id, so a new migration cannot silently leave data behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

const DIR=new URL('../cloudflare/migrations/',import.meta.url);
const runbook=readFileSync(new URL('./runbooks/former-member-deletion.md',import.meta.url),'utf8');

test('runbook deletes from every table keyed by a member id',()=>{
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(f,DIR),'utf8'));
  const keyed=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'").all().map(r=>r.name)
    .filter(t=>db.prepare(`PRAGMA table_info(${t})`).all().some(c=>c.name==='user_id'||c.name==='user_key'));
  assert.ok(keyed.length>10);
  for(const t of keyed)assert.match(runbook,new RegExp(`DELETE FROM ${t} WHERE`),t);
  db.close();
});

test('runbook keeps requests private and parents last',()=>{
  assert.match(runbook,/Never discuss the request[^.]*public GitHub issue/);
  assert.ok(runbook.indexOf('DELETE FROM identity_links')>runbook.indexOf('DELETE FROM whoop_members'));
  assert.ok(runbook.lastIndexOf('DELETE FROM')===runbook.indexOf('DELETE FROM identity_links'),'identity_links is deleted last');
});

test('runbook delete block runs cleanly with foreign keys on (synthetic member)',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(f,DIR),'utf8'));
  const U='0b0b0b0b-0000-4000-8000-00000000000b',OTHER='0c0c0c0c-0000-4000-8000-00000000000c';
  for(const id of [U,OTHER]){
    db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,0)').run(id);
  }
  const block=runbook.split('## 4.')[1].match(/```sql\n([\s\S]*?)```/)[1].replaceAll(':U',U);
  db.exec('BEGIN');db.exec(block);db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM identity_links WHERE user_id=?').get(U).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM identity_links WHERE user_id=?').get(OTHER).n,1,'other members untouched');
  const counts=runbook.split('## 3.')[1].match(/```sql\n([\s\S]*?)```/)[1].replaceAll(':U',U);
  assert.ok(db.prepare(counts).all().every(r=>Object.values(r)[1]===0));
  db.close();
});
