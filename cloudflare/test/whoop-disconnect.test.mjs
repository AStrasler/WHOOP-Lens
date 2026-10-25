// RB-017: best-effort WHOOP revoke before local deletion. Synthetic ids,
// synthetic tokens and a fake fetcher only; no live WHOOP call.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {sealWithKeyring,tokenKeyring} from '../src/token-crypto.mjs';
import {disconnectWhoop,WHOOP_REVOKE_URL,REVOKED_MESSAGE,MANUAL_MESSAGE} from '../src/whoop-disconnect.mjs';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW=Date.parse('2026-10-25T12:00:00Z');
const key=randomBytes(32).toString('base64url');
const ON={WHOOP_TOKEN_AES256_KEY:key,WHOOP_PROVIDER_REVOKE_ENABLED:'true'};
const OFF={WHOOP_TOKEN_AES256_KEY:key};
const DIR=new URL('../migrations/',import.meta.url);
async function fixture({expires=NOW+3600000}={}){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(f,DIR),'utf8'));
  const keys=tokenKeyring(ON);
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
    sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,'',?,?,'v1','public')")
      .run(id,new Date(expires).toISOString(),await sealWithKeyring(`synthetic-access-${id.slice(0,4)}`,{userId:id,purpose:'access',keys}),await sealWithKeyring('synthetic-refresh',{userId:id,purpose:'refresh',keys}));
  }
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
const conns=(db,id)=>db.sqlite.prepare('SELECT COUNT(*) n FROM whoop_connections WHERE user_id=?').get(id).n;
const now=()=>NOW;

test('revokes at WHOOP with the caller token, then deletes locally; other member untouched',async()=>{
  const db=await fixture();try{
    const calls=[];
    const r=await disconnectWhoop(db,A,ON,{now,fetcher:async(url,init)=>{calls.push({url,method:init.method,auth:init.headers.authorization,conns:conns(db,A)});return new Response(null,{status:204});}});
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,WHOOP_REVOKE_URL);assert.equal(calls[0].method,'DELETE');
    assert.equal(calls[0].auth,'Bearer synthetic-access-aaaa');
    assert.equal(calls[0].conns,1,'provider revoke happens before local deletion');
    assert.deepEqual(r,{disconnected:true,removed:true,whoop_access_revoked:true,whoop_revoke_reason:'whoop_revoked',message:REVOKED_MESSAGE});
    assert.equal(conns(db,A),0);assert.equal(conns(db,B),1);
  }finally{db.close();}
});

for(const [label,fetcher,reason] of [
  ['network error',async()=>{throw Error('offline');},'whoop_revoke_network'],
  ['401',async()=>new Response(null,{status:401}),'whoop_revoke_unauthorized'],
  ['429',async()=>new Response(null,{status:429}),'whoop_revoke_rate_limited'],
  ['500',async()=>new Response('upstream secret text',{status:500}),'whoop_revoke_unavailable'],
  ['400',async()=>new Response(null,{status:400}),'whoop_revoke_rejected'],
]){
  test(`WHOOP ${label}: local deletion still proceeds, sanitized reason, manual instructions`,async()=>{
    const db=await fixture();try{
      const r=await disconnectWhoop(db,A,ON,{now,fetcher});
      assert.deepEqual(r,{disconnected:true,removed:true,whoop_access_revoked:false,whoop_revoke_reason:reason,message:MANUAL_MESSAGE});
      assert.doesNotMatch(JSON.stringify(r),/synthetic-access|upstream secret|Bearer/);
      assert.equal(conns(db,A),0);assert.equal(conns(db,B),1);
    }finally{db.close();}
  });
}

test('expired access token: no refresh, no provider call, local deletion proceeds',async()=>{
  const db=await fixture({expires:NOW-1000});try{
    let called=0;
    const r=await disconnectWhoop(db,A,ON,{now,fetcher:async()=>{called++;return new Response(null,{status:204});}});
    assert.equal(called,0);
    assert.equal(r.whoop_revoke_reason,'whoop_revoke_token_expired');assert.equal(r.message,MANUAL_MESSAGE);
    assert.equal(conns(db,A),0);
  }finally{db.close();}
});

test('disabled by default: no provider call, behaviour is local deletion plus instructions',async()=>{
  const db=await fixture();try{
    let called=0;
    const r=await disconnectWhoop(db,A,OFF,{now,fetcher:async()=>{called++;return new Response(null,{status:204});}});
    assert.equal(called,0);
    assert.deepEqual(r,{disconnected:true,removed:true,whoop_access_revoked:false,whoop_revoke_reason:'whoop_revoke_disabled',message:MANUAL_MESSAGE});
  }finally{db.close();}
});

test('no stored connection or inactive member: no provider call',async()=>{
  const db=await fixture();try{
    let called=0;const fetcher=async()=>{called++;return new Response(null,{status:204});};
    db.sqlite.prepare('DELETE FROM whoop_connections WHERE user_id=?').run(A);
    const r=await disconnectWhoop(db,A,ON,{now,fetcher});
    assert.equal(r.whoop_revoke_reason,'whoop_revoke_no_connection');assert.equal(r.removed,false);
    db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(B);
    await assert.rejects(disconnectWhoop(db,B,ON,{now,fetcher}),/Membership required/);
    assert.equal(called,0);assert.equal(conns(db,B),1);
  }finally{db.close();}
});

test('undecryptable token: no provider call, local deletion proceeds',async()=>{
  const db=await fixture();try{
    let called=0;
    const r=await disconnectWhoop(db,A,{...ON,WHOOP_TOKEN_AES256_KEY:randomBytes(32).toString('base64url')},{now,fetcher:async()=>{called++;return new Response(null,{status:204});}});
    assert.equal(called,0);assert.equal(r.whoop_revoke_reason,'whoop_revoke_token_unavailable');assert.equal(conns(db,A),0);
  }finally{db.close();}
});
