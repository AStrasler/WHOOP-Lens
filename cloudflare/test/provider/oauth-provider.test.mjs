// Real pinned provider logic under Node. Only the unused Workers RPC base class
// is shimmed; storage and upstream HTTP are disposable synthetic test doubles.
import {registerHooks} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {makeConsentFlow as baseConsentFlow} from '../../oauth/auth-server/src/consent-flow.mjs';
import {checkUpstreamConfig,upstreamAuthorizationUrl,createVerifier,createChallenge,verifyUpstreamCode} from '../fixtures/legacy-supabase-upstream.mjs';
import {d1Prepare} from '../d1-sqlite.mjs';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true
  };
  return next(specifier,context);
}});
const {authorizationErrorRedirect}=await import('@cloudflare/workers-oauth-provider');
const {server}=await import('../../oauth/auth-server/src/index.mjs');
const ORIGIN='https://auth.whooplens.tech',RESOURCE='https://whooplens.tech/mcp';
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
class MemoryKV {
  records=new Map(); now=0;
  async put(key,value,options={}){this.records.set(key,{value,
    expires:options.expirationTtl?this.now+options.expirationTtl:Infinity});}
  async get(key,type){const r=this.records.get(key);
    if(!r||r.expires<=this.now)return null;
    return (type==='json'||type?.type==='json')?JSON.parse(r.value):r.value;}
  async delete(key){this.records.delete(key);}
  async list({prefix='' }={}){return {keys:[...this.records.keys()]
    .filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
}
function cookies(response){return response.headers.getSetCookie()
  .filter(s=>!s.includes('Max-Age=0')).map(s=>s.split(';')[0]).join('; ');}
function request(path,method='GET',body,cookie=''){
  return new Request(ORIGIN+path,{method,headers:{cookie,origin:ORIGIN,
    ...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},
    body:body?new URLSearchParams(body):undefined});
}
async function fixture(){
  const kv=new MemoryKV(),db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../migrations/0001_initial.sql',import.meta.url),'utf8'));
  db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(USER,USER);
  db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(USER);
  const env={OAUTH_KV:kv,OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true',
    SUPABASE_UPSTREAM_CLIENT_ID:'synthetic-client',SUPABASE_PUBLIC_KEY:'synthetic-key',
    DB:{prepare:d1Prepare(db)}};
  const oauth=server.getOAuthApi(env),http=[],verifiers=[];
  const client=await oauth.createClient({clientName:'Synthetic client',
    redirectUris:['https://client.invalid/callback'],tokenEndpointAuthMethod:'none',
    grantTypes:['authorization_code','refresh_token'],responseTypes:['code']});
  const flow=makeConsentFlow({getOAuth:()=>oauth,errorRedirect:authorizationErrorRedirect,
    pkceVerifier:()=>{const v=createVerifier();verifiers.push(v);return v;},
    verifyIdentity:args=>verifyUpstreamCode({...args,fetcher:async(url,options)=>{
      http.push({url,options});
      assert.equal(new URL(url).origin,'https://evoiwauqplbcecumiwqn.supabase.co');
      if(url.endsWith('/oauth/token'))return Response.json({access_token:'synthetic-token-1234567890'});
      if(url.endsWith('/auth/v1/user'))return Response.json({id:USER});
      if(url.endsWith('/logout?scope=local'))return new Response(null,{status:204});
      throw Error('Unexpected outbound request');
    }})});
  async function start(offline=false,requestedScope='mcp:read offline_access'){
    const verifier=createVerifier();
    const query=new URLSearchParams({client_id:client.clientId,
      redirect_uri:'https://client.invalid/callback',response_type:'code',
      scope:requestedScope,state:'synthetic-client-state',resource:RESOURCE,
      code_challenge:await createChallenge(verifier),code_challenge_method:'S256'});
    const page=await flow.authorize(request('/authorize?'+query),env);
    assert.equal(page.status,200);
    const handle=(await page.text()).match(/name="handle" value="([^"]+)"/)[1];
    const consentCookie=cookies(page);
    const selection=new URLSearchParams({handle,decision:'approve',scope:'mcp:read'});
    if(offline)selection.append('scope','offline_access');
    const approved=await flow.authorize(request('/authorize','POST',selection,consentCookie),env);
    assert.equal(approved.status,302);
    const upstream=new URL(approved.headers.get('location'));
    const state=upstream.searchParams.get('state'),cookie=cookies(approved);
    return {state,cookie,handle,consentCookie,verifier,
      callback:'/oauth/upstream/callback?'+new URLSearchParams({state,code:'synthetic-code'})};
  }
  return {kv,db,env,server,oauth,flow,http,client,start,verifiers};
}
test('real provider binds consent and upstream cookies; rejects replay and another browser',async()=>{
  const f=await fixture();try{
    const a=await f.start(),b=await f.start();
    assert.notEqual(a.cookie,b.cookie);
    for(const cookie of ['',b.cookie,a.cookie+'corrupted']){
      assert.equal((await f.flow.callback(request(a.callback,'GET',null,cookie),f.env)).status,401);
    }
    assert.equal(f.http.length,0);
    const done=await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env);
    assert.equal(done.status,302);
    assert.match(done.headers.get('set-cookie'),/Max-Age=0/);
    const destination=new URL(done.headers.get('location'));
    assert.equal(destination.origin,'https://client.invalid');
    assert.equal(destination.searchParams.get('state'),'synthetic-client-state');
    assert.ok(destination.searchParams.get('code'));
    assert.equal(f.http.length,3);
    assert.equal((await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env)).status,401);
    assert.equal(f.http.length,3);
    const consentReplay=await f.flow.authorize(request('/authorize','POST',
      {handle:a.handle,decision:'approve',scope:'mcp:read'},a.consentCookie),f.env);
    assert.equal(consentReplay.status,400);
    // A second tab remains independent after the first completes.
    assert.equal((await f.flow.callback(request(b.callback,'GET',null,b.cookie),f.env)).status,302);
  }finally{f.db.close();}
});
test('real provider expires and encrypts state; rejects modified stored ciphertext',async()=>{
  const f=await fixture();try{
    const a=await f.start();
    const stored=JSON.stringify([...f.kv.records.entries()]);
    assert.ok(!stored.includes(a.state));
    assert.ok(!stored.includes(f.verifiers[0]));
    assert.ok(!stored.includes('grantedScopes'));
    f.kv.now=601;
    assert.equal((await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env)).status,401);
    const b=await f.start();
    for(const [key,value] of f.kv.records)if(key.startsWith('transaction:'))value.value='corrupted';
    assert.equal((await f.flow.callback(request(b.callback,'GET',null,b.cookie),f.env)).status,401);
    assert.equal(f.http.length,0);
  }finally{f.db.close();}
});
test('inactive identity fails after upstream verification and clears consumed cookie',async()=>{
  const f=await fixture();try{
    const a=await f.start();
    f.db.prepare('UPDATE whoop_members SET active=0').run();
    const denied=await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env);
    assert.equal(denied.status,401);
    assert.match(denied.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal(denied.headers.get('referrer-policy'),'no-referrer');
    assert.equal(f.http.length,3);
    assert.equal([...f.kv.records.keys()].some(k=>k.startsWith('grant:')),false);
  }finally{f.db.close();}
});
test('real downstream code requires original PKCE and yields only selected scope and user props',async()=>{
  const f=await fixture();try{
    const a=await f.start();
    const done=await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env);
    const code=new URL(done.headers.get('location')).searchParams.get('code');
    const pending=[];
    const exchange=verifier=>f.server.fetch(request('/oauth/token','POST',{
      grant_type:'authorization_code',client_id:f.client.clientId,
      code,code_verifier:verifier,redirect_uri:'https://client.invalid/callback',resource:RESOURCE
    }),f.env,{waitUntil:p=>pending.push(p)});
    const wrong=await exchange(createVerifier());
    assert.equal(wrong.status,400);
    const result=await exchange(a.verifier);
    assert.equal(result.status,200);
    const tokens=await result.json();
    assert.equal(tokens.scope,'mcp:read');
    assert.equal(tokens.refresh_token,undefined);
    const validated=await f.server.validateToken(RESOURCE,tokens.access_token,f.env);
    assert.equal(validated.userId,USER);
    assert.deepEqual(validated.props,{userId:USER});
    assert.deepEqual(validated.scope,['mcp:read']);
    const replay=await exchange(a.verifier);
    assert.equal(replay.status,400);
    await Promise.all(pending);
    assert.ok(!JSON.stringify([...f.kv.records.values()]).includes('synthetic-token-1234567890'));
  }finally{f.db.close();}
});
test('offline consent permits refresh, narrowed scopes cannot be expanded and revocation works',async()=>{
  const f=await fixture();try{
    const a=await f.start(true),pending=[];
    const send=body=>f.server.fetch(request('/oauth/token','POST',{
      client_id:f.client.clientId,resource:RESOURCE,...body
    }),f.env,{waitUntil:p=>pending.push(p)});
    const done=await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env);
    const issued=await send({grant_type:'authorization_code',
      code:new URL(done.headers.get('location')).searchParams.get('code'),
      code_verifier:a.verifier,redirect_uri:'https://client.invalid/callback'});
    assert.equal(issued.status,200);
    const tokens=await issued.json();
    assert.equal(typeof tokens.refresh_token,'string');
    const refreshed=await send({grant_type:'refresh_token',refresh_token:tokens.refresh_token,
      scope:'mcp:read'});
    assert.equal(refreshed.status,200);
    const next=await refreshed.json();
    assert.equal(next.scope,'mcp:read');
    const invalid=await send({grant_type:'refresh_token',refresh_token:next.refresh_token,
      scope:'mcp:write'});
    assert.equal(invalid.status,400);
    const grants=await f.oauth.listUserGrants(USER);
    assert.equal(grants.items.length,1);
    await f.oauth.revokeGrant(grants.items[0].id,USER);
    assert.equal(await f.server.validateToken(RESOURCE,next.access_token,f.env),null);
    assert.equal((await send({grant_type:'refresh_token',refresh_token:next.refresh_token})).status,400);
    await Promise.all(pending);
  }finally{f.db.close();}
});
test('a client that never requests offline_access still receives a usable refresh token',async()=>{
  const f=await fixture();try{
    const a=await f.start(false,'mcp:read'),pending=[];
    const send=body=>f.server.fetch(request('/oauth/token','POST',{
      client_id:f.client.clientId,resource:RESOURCE,...body
    }),f.env,{waitUntil:p=>pending.push(p)});
    const done=await f.flow.callback(request(a.callback,'GET',null,a.cookie),f.env);
    const issued=await send({grant_type:'authorization_code',
      code:new URL(done.headers.get('location')).searchParams.get('code'),
      code_verifier:a.verifier,redirect_uri:'https://client.invalid/callback'});
    assert.equal(issued.status,200);
    const tokens=await issued.json();
    assert.equal(tokens.scope,'mcp:read');
    assert.equal(typeof tokens.refresh_token,'string');
    const validated=await f.server.validateToken(RESOURCE,tokens.access_token,f.env);
    assert.deepEqual(validated.props,{userId:USER});
    const refreshed=await send({grant_type:'refresh_token',refresh_token:tokens.refresh_token});
    assert.equal(refreshed.status,200);
    assert.equal((await refreshed.json()).scope,'mcp:read');
    await Promise.all(pending);
  }finally{f.db.close();}
});
test('resource routes the WHOOP callback and Health Connect webhook outside MCP bearer validation',async()=>{
  const {default:resource}=await import('../../oauth/resource/src/index.mjs');
  let consumed=0,validated=0;
  const env={OAUTH_RESOURCE_ENABLED:'true',MIGRATION_API_ENABLED:'true',WHOOP_OAUTH_ENABLED:'true',
    WHOOP_CLIENT_ID:'synthetic',WHOOP_CLIENT_SECRET:'synthetic',WHOOP_TOKEN_AES256_KEY:'synthetic',
    WHOOP_REDIRECT_URI:'https://whooplens.tech/api/whoop/callback',
    AUTH_SERVER:{async validateToken(){validated++;return null;}},
    DB:{prepare(sql){assert.match(sql,/DELETE FROM whoop_oauth_states/);return {
      bind(){return this;},async first(){consumed++;return null;}
    };}}};
  const callback=new Request('https://whooplens.tech/api/whoop/callback?code=synthetic&state='+'S'.repeat(43));
  const result=await resource.fetch(callback,env,{});
  assert.equal(result.status,400);assert.equal(consumed,1);assert.equal(validated,0);
  const gated=await resource.fetch(callback,{...env,WHOOP_OAUTH_ENABLED:'false'},{});
  assert.equal(gated.status,503);assert.equal(consumed,1);
  const webhook=await resource.fetch(new Request('https://whooplens.tech/api/health-connect/webhook',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer hct_not-a-real-token'},
    body:'{"timestamp":"2026-10-13T00:00:00Z","app_version":"1.9.22"}'
  }),env,{});
  assert.equal(webhook.status,503);
  assert.equal(validated,0);
  const unauthenticated=await resource.fetch(new Request('https://whooplens.tech/mcp',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}'}),env,{});
  assert.equal(unauthenticated.status,401);
  assert.equal(consumed,1);
});

function makeConsentFlow(options){return baseConsentFlow({checkConfig:checkUpstreamConfig,startUrl:upstreamAuthorizationUrl,verifyIdentity:verifyUpstreamCode,...options});}
test('member cannot add offline_access that the client never requested',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.start(true,'mcp:read'));
    assert.equal(f.http.length,0);
    assert.equal([...f.kv.records.keys()].some(k=>k.startsWith('grant:')),false);
  }finally{f.db.close();}
});
