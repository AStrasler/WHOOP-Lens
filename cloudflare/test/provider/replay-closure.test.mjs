import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,deferred,A,B,C,RESOURCE,req} from './replay-harness.mjs';
test('recovery: old token retries until successor use; no second durable lineage',async()=>{
 const f=await fixture();try{
  const t0=await f.issue();const t1=await (await f.refresh(t0.refresh_token)).json();
  const retry=await f.refresh(t0.refresh_token,1);assert.equal(retry.status,200);
  const recovered=await retry.json();assert.equal((await f.refresh(t1.refresh_token)).status,400);
  const t2=await (await f.refresh(recovered.refresh_token)).json();
  assert.equal((await f.refresh(t0.refresh_token)).status,400);
  assert.equal((await f.refresh(t1.refresh_token)).status,400);
  assert.equal((await f.refresh(t2.refresh_token)).status,200);
 }finally{await f.close();}
});
test('recovery: previous-token retry is bounded by grant lifetime, not a short timer',async t=>{
 const f=await fixture();try{
  const t0=await f.issue();await f.refresh(t0.refresh_token);
  const base=Date.now();t.mock.method(Date,'now',()=>base+3600000);f.kv.now=3600;assert.equal((await f.refresh(t0.refresh_token,1)).status,200);
  t.mock.method(Date,'now',()=>base+2595601000);f.kv.now=2595601;assert.equal((await f.refresh(t0.refresh_token)).status,400);
 }finally{await f.close();}
});
test('parallel refresh: only the final persisted successor remains refreshable',async()=>{
 const f=await fixture();try{
  const initial=await f.issue();const responses=await Promise.all([f.refresh(initial.refresh_token),f.refresh(initial.refresh_token,1)]);
  if(f.strong){
   assert.deepEqual(responses.map(r=>r.status).sort(),[200,503]);
   const winner=await responses.find(r=>r.status===200).json();
   assert.equal((await f.refresh(winner.refresh_token,1)).status,200);return;
  }
  assert.deepEqual(responses.map(r=>r.status),[200,200]);const tokens=await Promise.all(responses.map(r=>r.json()));
  const outcomes=await Promise.all(tokens.map((t,i)=>f.refresh(t.refresh_token,i)));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,400]);
  // Both access tokens can outlive the race, but cannot exceed the same member/scope.
  for(const t of tokens){const v=await f.instances[0].validateToken(RESOURCE,t.access_token,f.storageEnv());assert.equal(v.props.userId,A);assert.deepEqual(v.scope,['mcp:read','offline_access']);}
 }finally{await f.close();}
});
test('lost response: retry initial token recovers; previously returned sibling invalidates',async()=>{
 const f=await fixture();try{
  const t0=await f.issue();const lost=await (await f.refresh(t0.refresh_token)).json();
  const recovered=await (await f.refresh(t0.refresh_token,1)).json();
  assert.equal((await f.refresh(lost.refresh_token)).status,400);
  assert.equal((await f.refresh(recovered.refresh_token)).status,200);
 }finally{await f.close();}
});
test('INVARIANT: delayed refresh cannot resurrect a revoked grant',async()=>{
 const f=await fixture();try{
  const t0=await f.issue(),entered=deferred(),release=deferred();
  f.kv.onPut=async key=>{if(key.startsWith('grant:')){entered.resolve();await release.promise;}};
  const pending=f.refresh(t0.refresh_token,1);await entered.promise;
  const [user,grant]=t0.refresh_token.split(':');await f.apis[0].revokeGrant(grant,user);
  release.resolve();const r=await pending;
  assert.notEqual(r.status,200,'revocation must beat an in-flight rotation');
 }finally{await f.close();}
});
test('INVARIANT: delayed older write cannot restore the spent grandparent token',async()=>{
 const f=await fixture();try{
  const t0=await f.issue(),entered=deferred(),release=deferred();let first=true;
  f.kv.onPut=async key=>{if(key.startsWith('grant:')&&first){first=false;entered.resolve();await release.promise;}};
  const delayed=f.refresh(t0.refresh_token,0);await entered.promise;
  const t1=await (await f.refresh(t0.refresh_token,1)).json();
  await f.refresh(t1.refresh_token,1);
  assert.equal((await f.refresh(t0.refresh_token,1)).status,400);
  release.resolve();await delayed;
  assert.equal((await f.refresh(t0.refresh_token,1)).status,400,'stale write must not reopen token recovery');
 }finally{await f.close();}
});
test('MODEL: stale KV replicas can diverge; D1 adapters converge on one authority',async()=>{
 const f=await fixture();try{
  const t0=await f.issue(),snapshot=new Map(f.kv.records);
  if(f.strong){
   const first=await (await f.refresh(t0.refresh_token)).json();
   await f.refresh(first.refresh_token,1);
   assert.equal((await f.refresh(t0.refresh_token)).status,400);
   return;
  }
  const {KV}=await import('./replay-harness.mjs');const replica=new KV();replica.records=snapshot;
  const env2={...f.env,OAUTH_KV:replica};
  const branch2=async token=>f.instances[1].fetch(req('/oauth/token',{client_id:f.client.clientId,resource:RESOURCE,grant_type:'refresh_token',refresh_token:token}),env2,{waitUntil(){}});
  let left=t0,right=t0;
  for(let n=0;n<3;n++){
   const a=await f.refresh(left.refresh_token),b=await branch2(right.refresh_token);
   assert.equal(a.status,200);assert.equal(b.status,200);left=await a.json();right=await b.json();
  }
  // This is a deliberately stale replica model, not proof of production KV timing.
  assert.notEqual(left.refresh_token,right.refresh_token,'model: both replica-local branches advanced three generations');
 }finally{await f.close();}
});
test('GET callbacks: serial replay, wrong browser, malformed and expired states fail closed',async()=>{
 const f=await fixture();try{
  const a=await f.start(),b=await f.start();
  assert.equal((await f.callback(a,1,A,{cookie:b.cookie})).status,401);
  for(const suffix of ['&code=duplicate','&error=access_denied','&state=duplicate','&iss=a&iss=b']){
   assert.equal((await f.callback({...a,path:a.path+suffix})).status,400);
  }
  const good=await f.callback(a);assert.equal(good.status,302);
  assert.equal((await f.callback(a,1)).status,401);
  const expired=await f.start();f.kv.now=601;assert.equal((await f.callback(expired,1)).status,401);
 }finally{await f.close();}
});
test('INVARIANT: simultaneous GET callbacks consume one state exactly once',async()=>{
 const f=await fixture();try{
  const a=await f.start(),gate=deferred();let reads=0;
  f.kv.onGet=async(key,v)=>{if(key.startsWith('transaction:')&&v){if(++reads===2)gate.resolve();await gate.promise;}return v;};
  const rs=await Promise.all([f.callback(a,0),f.callback(a,1)]);
  assert.equal(rs.filter(r=>r.status===302).length,1,'only one callback may issue an authorization code');
 }finally{await f.close();}
});
test('INVARIANT: replayed Early-Data GET callback cannot issue two grants (model only)',async()=>{
 const f=await fixture();try{
  const a=await f.start(),gate=deferred();let reads=0;
  f.kv.onGet=async(key,v)=>{if(key.startsWith('transaction:')&&v){if(++reads===2)gate.resolve();await gate.promise;}return v;};
  const rs=await Promise.all([f.callback(a,0,A,{early:true}),f.callback(a,1,A,{early:true})]);
  assert.deepEqual(rs.map(r=>r.status),[425,425],'manual header tests application rejection only');
 }finally{await f.close();}
});
test('identities: real signed Access claims keep two active members separate and reject inactive member',async()=>{
 const f=await fixture();try{
  for(const user of [A,B]){
   const t=await f.issue(user);for(const s of f.instances){
    const verified=await s.validateToken(RESOURCE,t.access_token,f.storageEnv());assert.equal(verified.props.userId,user);
    assert.equal(await s.validateToken('https://whooplens.tech/other',t.access_token,f.storageEnv()).catch(()=>null),null);
   }
  }
  const state=await f.start();assert.equal((await f.callback(state,1,C)).status,401);
 }finally{await f.close();}
});
test('callback HEAD and OPTIONS cannot consume valid upstream state',async()=>{
 const f=await fixture();try{
  const a=await f.start();for(const method of ['HEAD','OPTIONS']){
   assert.equal((await f.flows[0].callback(req(a.path,null,a.cookie,method),f.env)).status,403);
  }
  assert.equal((await f.callback(a,1)).status,302);
 }finally{await f.close();}
});
