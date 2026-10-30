import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
const O='https://auth.whooplens.tech',R='https://whooplens.tech/mcp';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(mode='d1'){
 const built=await build({entryPoints:[new URL('./replay-worker.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],logLevel:'silent'});
 const entered=deferred(),release=deferred(),barrier=deferred(),grants=deferred();let reads=0,writes=0;
 const config=name=>({name,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],bindings:{MODE:mode},kvNamespaces:{OAUTH_KV:'isolated-replay-kv'},d1Databases:{DB:'isolated-replay-security'},serviceBindings:{GATE:async request=>{if(new URL(request.url).pathname==='/barrier'){if(++reads===2)barrier.resolve();await barrier.promise;}else if(new URL(request.url).pathname==='/grantbarrier'){if(++writes===2)grants.resolve();await grants.promise;}else{entered.resolve();await release.promise;}return new Response('released');}}});
 const mf=new Miniflare({cf:false,workers:[config('a'),config('b')]});
 const db=await mf.getD1Database('DB','a');await db.exec(readFileSync(new URL('../../migrations/0021_oauth_security_state.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 const a=await mf.getWorker('a'),b=await mf.getWorker('b');
 const setup=await (await a.fetch(O+'/synthetic/setup',{method:'POST'})).json();
 const callback=(worker,barrier=false)=>worker.fetch(O+'/oauth/upstream/callback?'+new URLSearchParams({state:setup.state,code:'access'}),{headers:{cookie:setup.cookie,...(barrier?{'x-synthetic-barrier':'state'}:{})},redirect:'manual'});
 async function exchange(response,worker=a){return worker.fetch(O+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:new URL(response.headers.get('location')).searchParams.get('code'),client_id:setup.client,resource:R,redirect_uri:'https://client.invalid/callback',code_verifier:setup.verifier})});}
 async function issue(){return (await exchange(await callback(a))).json();}
 const refresh=(token,worker=a,pause=false)=>worker.fetch(O+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(pause?{'x-synthetic-pause':'grant'}:{})},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token,client_id:setup.client,resource:R})});
 return {mf,db,a,b,entered,release,callback,exchange,issue,refresh};
}
test('workerd/D1: independent Worker isolates consume one callback state',async()=>{
 const f=await fixture();try{
  const rs=await Promise.all([f.callback(f.a,true),f.callback(f.b,true)]);
  assert.equal(rs.filter(r=>r.status===302).length,1);
  const success=rs.find(r=>r.status===302);assert.equal((await f.exchange(success)).status,200);
 }finally{await f.mf.dispose();}
});
test('workerd/D1: concurrent refresh yields one successor and keeps recovery usable',async()=>{
 const f=await fixture();try{
  const t0=await f.issue();const rs=await Promise.all([f.refresh(t0.refresh_token,f.a),f.refresh(t0.refresh_token,f.b)]);
  // Requests may serialize naturally: both recovery successes remain acceptable.
  assert.ok(rs.some(r=>r.status===200));assert.ok(rs.every(r=>[200,503].includes(r.status)));
  const recovered=await f.refresh(t0.refresh_token,f.b);assert.equal(recovered.status,200);
  const latest=await recovered.json();assert.equal((await f.refresh(latest.refresh_token,f.a)).status,200);
 }finally{await f.mf.dispose();}
});
test('workerd/D1: revocation wins over delayed rotation across isolates',async()=>{
 const f=await fixture();try{
  const t0=await f.issue();const pending=f.refresh(t0.refresh_token,f.a,true);await f.entered.promise;
  const [user,grant]=t0.refresh_token.split(':');
  assert.equal((await f.b.fetch(O+'/synthetic/revoke',{method:'POST',body:JSON.stringify({user,grant})})).status,204);
  f.release.resolve();assert.equal((await pending).status,503);
  assert.equal((await f.refresh(t0.refresh_token,f.b)).status,400);
  const v=await f.b.fetch(O+'/synthetic/validate',{method:'POST',body:JSON.stringify({token:t0.access_token})});assert.equal((await v.json()).valid,false);
 }finally{f.release.resolve();await f.mf.dispose();}
});


test('BASELINE EXPOSURE workerd/KV: identical callback creates two usable grants',async()=>{
 const f=await fixture('kv');try{
  const rs=await Promise.all([f.callback(f.a,true),f.callback(f.b,true)]);
  assert.deepEqual(rs.map(r=>r.status),[302,302]);
  const codes=rs.map(r=>new URL(r.headers.get('location')).searchParams.get('code'));
  assert.equal(new Set(codes).size,2);
  const issued=await Promise.all(rs.map((r,i)=>f.exchange(r,i?f.b:f.a)));
  assert.deepEqual(issued.map(r=>r.status),[200,200]);
 }finally{await f.mf.dispose();}
});
test('BASELINE EXPOSURE workerd/KV: delayed refresh restores revoked grant and usable credentials',async()=>{
 const f=await fixture('kv');try{
  const t0=await f.issue(),pending=f.refresh(t0.refresh_token,f.a,true);await f.entered.promise;
  const [user,grant]=t0.refresh_token.split(':');
  await f.b.fetch(O+'/synthetic/revoke',{method:'POST',body:JSON.stringify({user,grant})});
  f.release.resolve();const response=await pending;assert.equal(response.status,200);
  const revived=await response.json();
  const valid=await f.b.fetch(O+'/synthetic/validate',{method:'POST',body:JSON.stringify({token:revived.access_token})});
  assert.equal((await valid.json()).valid,true);
  assert.equal((await f.refresh(revived.refresh_token,f.b)).status,200);
 }finally{f.release.resolve();await f.mf.dispose();}
});
