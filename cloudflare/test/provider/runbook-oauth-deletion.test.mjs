import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fixture,A,B,RESOURCE,deferred} from './replay-harness.mjs';
const text=readFileSync(new URL('../../../docs/runbooks/former-member-deletion.md',import.meta.url),'utf8').replaceAll('\r\n','\n');
const block=name=>text.split(name)[1].match(/```sql\n([\s\S]*?)```/)[1].replaceAll(':U',A);
async function fullFixture(){
 const f=await fixture();
 const dir=new URL('../../migrations/',import.meta.url);
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())f.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
 return f;
}
test('runbook health-only deletion preserves actual provider credentials for both members',async()=>{
 const f=await fullFixture();try{
  const a=await f.issue(A),b=await f.issue(B);
  f.sqlite.exec('BEGIN');f.sqlite.exec(block('### 4a.'));f.sqlite.exec('COMMIT');
  assert.equal((await f.instances[0].validateToken(RESOURCE,a.access_token,f.storageEnv())).props.userId,A);
  assert.equal((await f.refresh(a.refresh_token,1)).status,200);
  assert.equal((await f.instances[1].validateToken(RESOURCE,b.access_token,f.storageEnv())).props.userId,B);
 }finally{await f.close();}
});
test('runbook full deletion defeats delayed OAuth rotation and old credentials after re-enrolment',async()=>{
 const f=await fullFixture(),entered=deferred(),release=deferred();try{
  const a=await f.issue(A),b=await f.issue(B);let stopped=false;
  f.kv.onPut=async key=>{if(key.startsWith('grant:'+A+':')&&!stopped){stopped=true;entered.resolve();await release.promise;}};
  const pending=f.refresh(a.refresh_token,1);await entered.promise;
  // Actual full-deletion prerequisites and the actual SQL blocks.
  f.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
  f.sqlite.prepare('UPDATE access_identity_links SET enabled=0 WHERE user_id=?').run(A);
  f.sqlite.exec('BEGIN');f.sqlite.exec(block('### 4a.'));f.sqlite.exec(block('### 4b.'));f.sqlite.exec('COMMIT');
  release.resolve();assert.equal((await pending).status,503);
  assert.equal(await f.instances[0].validateToken(RESOURCE,a.access_token,f.storageEnv()),null);
  assert.equal((await f.refresh(a.refresh_token)).status,400);
  assert.equal((await f.instances[1].validateToken(RESOURCE,b.access_token,f.storageEnv())).props.userId,B);
  // Reapproval of the same synthetic id must not revive its old grant.
  f.sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(A,A);
  f.sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(A);
  f.sqlite.prepare('INSERT INTO access_identity_links VALUES(?,?,?,1,?)').run(f.env.ACCESS_ISSUER,A,A,'2026-10-30');
  assert.equal((await f.refresh(a.refresh_token,1)).status,400);
  const fresh=await f.issue(A);
  assert.equal((await f.instances[0].validateToken(RESOURCE,fresh.access_token,f.storageEnv())).props.userId,A);
 }finally{release.resolve();await f.close();}
});
