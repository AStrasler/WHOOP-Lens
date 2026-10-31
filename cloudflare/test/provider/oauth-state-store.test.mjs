import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './replay-harness.mjs';
const {OAuthStateStore,oauthStateEnv}=await import('../../oauth/auth-server/src/oauth-state-store.mjs');
test('D1 state: consumed transaction cannot be claimed by another request',async()=>{
 const f=await fixture();try{
  const one=new OAuthStateStore(f.env.DB),two=new OAuthStateStore(f.env.DB);
  await one.put('transaction:synthetic','sealed',{expirationTtl:600});
  assert.equal(await two.get('transaction:synthetic'),'sealed');
  await one.delete('transaction:synthetic');await assert.rejects(two.delete('transaction:synthetic'));
  assert.equal(await new OAuthStateStore(f.env.DB).get('transaction:synthetic'),null);
 }finally{await f.close();}
});
test('D1 state: revocation blocks orphan access-token reads and delayed token publication',async()=>{
 const f=await fixture();try{
  const one=new OAuthStateStore(f.env.DB),two=new OAuthStateStore(f.env.DB);
  const grant='grant:synthetic:grant',token='token:synthetic:grant:token';
  await one.put(grant,'{}',{expirationTtl:600});await one.put(token,'{}',{expirationTtl:600});
  await two.delete(grant);
  assert.equal(await new OAuthStateStore(f.env.DB).get(token),null);
  await assert.rejects(one.put('token:synthetic:grant:delayed','{}',{expirationTtl:600}));
  await assert.rejects(one.put(grant,'{}',{expirationTtl:600}));
  await assert.rejects(new OAuthStateStore(f.env.DB).put(grant,'{}',{expirationTtl:600}));
 }finally{await f.close();}
});
test('D1 state: pagination preserves metadata and deletion cannot skip remaining pages',async()=>{
 const f=await fixture();try{
  const one=new OAuthStateStore(f.env.DB);
  for(let n=0;n<5;n++)await one.put('client:prefix_%:'+n,'{}',{metadata:{index:n},expirationTtl:600});
  let cursor='',removed=0;
  do{
   const page=await one.list({prefix:'client:prefix_%:',limit:2,cursor});cursor=page.cursor;
   for(const key of page.keys){assert.equal(typeof key.metadata.index,'number');await one.delete(key.name);removed++;}
   if(page.list_complete)break;
  }while(cursor);
  assert.equal(removed,5);assert.equal((await one.list({prefix:'client:prefix_%:'})).keys.length,0);
 }finally{await f.close();}
});
test('D1 state: explicit expiration and unknown grant remain fail closed',async()=>{
 const f=await fixture();try{
  let now=1000000;const one=new OAuthStateStore(f.env.DB,{now:()=>now});
  await one.put('transaction:expired','x',{expiration:1001});now=1001000;
  assert.equal(await one.get('transaction:expired'),null);
  await assert.rejects(one.delete('transaction:expired'));
  await assert.rejects(one.put('token:missing:grant:token','{}'));
 }finally{await f.close();}
});
test('D1 activation: new per-request adapters, no fallback on missing DB, legacy mode unchanged',async()=>{
 const kv={};assert.equal(oauthStateEnv({OAUTH_KV:kv}).OAUTH_KV,kv);
 assert.throws(()=>oauthStateEnv({OAUTH_STATE_STORE:'d1',OAUTH_KV:kv}));
 const f=await fixture();try{
  const a=oauthStateEnv({...f.env,OAUTH_STATE_STORE:'d1'}),b=oauthStateEnv({...f.env,OAUTH_STATE_STORE:'d1'});
  assert.notEqual(a.OAUTH_KV,b.OAUTH_KV);
 }finally{await f.close();}
});
