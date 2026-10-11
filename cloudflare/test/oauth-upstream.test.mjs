import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  createVerifier,createChallenge,upstreamAuthorizationUrl,
  verifyUpstreamCode,UpstreamSignInDenied,CALLBACK_URI
} from '../oauth/auth-server/src/upstream.mjs';
import {makeConsentFlow} from '../oauth/auth-server/src/consent-flow.mjs';
import {consentPage} from '../oauth/consent.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const env=db=>({
  DB:db,OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true',
  SUPABASE_UPSTREAM_CLIENT_ID:'synthetic-registered-client',
  SUPABASE_PUBLIC_KEY:'synthetic-publishable'
});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  for(const id of [A,B])
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(A);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,0)').run(B);
  return {sqlite,close:()=>sqlite.close(),prepare(sql){let args=[];return {
    bind(...v){args=v;return this;},
    async first(){return sqlite.prepare(sql).get(...args)??null;}
  };}};
}
const state='S'.repeat(43),handle='H'.repeat(43);
const req=(path,method='GET',form,headers={})=>new Request('https://auth.whooplens.tech'+path,{
  method,headers:{...(method==='POST'?{'content-type':'application/x-www-form-urlencoded'}:{}),...headers},
  body:method==='POST'?new URLSearchParams(form):undefined
});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function stub(){
  const calls={begin:0,approve:0,deny:0,upstream:0,finish:0,complete:0};
  const request={scope:['mcp:read','offline_access']};
  const oauth={
    async parseAuthRequest(){return request;},
    async describeConsent(){return {clientName:'<script>alert(1)</script>',
      redirectHost:'chatgpt.com',clientDomain:'chatgpt.com',
      scope:request.scope,redirectIsLoopback:false};},
    async beginConsent(){calls.begin++;return {handle,headers:new Headers({
      'set-cookie':'__Host-oauth-consent=private; Secure; HttpOnly; SameSite=Lax'})};},
    async approveConsent(_,h,{scope}){
      assert.equal(h,handle);assert.deepEqual(scope,['mcp:read']);
      calls.approve++;return {request,headers:new Headers({'set-cookie':'__Host-oauth-consent=; Max-Age=0'})};
    },
    async denyConsent(_,h){assert.equal(h,handle);calls.deny++;
      return {headers:new Headers({location:'https://chatgpt.com/denied'})};},
    async beginUpstream(r,{data,headers}){
      assert.equal(r,request);assert.deepEqual(data.grantedScopes,['mcp:read']);
      assert.match(data.verifier,/^[A-Za-z0-9_-]{43,128}$/);
      assert.ok(headers);
      calls.upstream++;calls.data=data;
      return {state,headers:new Headers({'set-cookie':'__Host-oauth-upstream=private; Secure; HttpOnly'})};
    },
    async finishUpstream(requestForCallback){
      assert.match(requestForCallback.headers.get('cookie')||'',/__Host-oauth-upstream=private/);
      calls.finish++;
      if(calls.finish>1)throw Error('state replay');
      return {request,data:calls.data,headers:new Headers({'set-cookie':'__Host-oauth-upstream=; Max-Age=0'})};
    },
    async completeAuthorization({request:r,userId,scope,props}){
      assert.equal(r,request);assert.equal(userId,A);assert.deepEqual(scope,['mcp:read']);
      assert.deepEqual(props,{userId:A});calls.complete++;
      return {redirectTo:'https://chatgpt.com/callback?code=synthetic-cloudflare-code'};
    }
  };
  return {oauth,calls};
}
test('PKCE S256 and state redirect are generated without receiving a password',async()=>{
  const db=fixture();try{
    const verifier=createVerifier();
    assert.match(verifier,/^[A-Za-z0-9_-]{43}$/);
    assert.match(await createChallenge(verifier),/^[A-Za-z0-9_-]{43}$/);
    const destination=new URL(await upstreamAuthorizationUrl({state,verifier,env:env(db)}));
    assert.equal(destination.origin,'https://evoiwauqplbcecumiwqn.supabase.co');
    assert.equal(destination.pathname,'/auth/v1/oauth/authorize');
    assert.equal(destination.searchParams.get('client_id'),'synthetic-registered-client');
    assert.equal(destination.searchParams.get('code_challenge_method'),'S256');
    assert.equal(destination.searchParams.get('redirect_uri'),CALLBACK_URI);
    assert.equal(destination.searchParams.get('scope'),'openid');
    assert.equal(destination.searchParams.get('state'),state);
    assert.equal(destination.searchParams.get('code_challenge'),await createChallenge(verifier));
    assert.equal(destination.searchParams.has('password'),false);
    await assert.rejects(upstreamAuthorizationUrl({state,verifier,env:{...env(db),
      SUPABASE_UPSTREAM_CLIENT_ID:''}}),UpstreamSignInDenied);
  }finally{db.close();}
});
test('explicit browser consent issues only an upstream redirect and no token',async()=>{
  const db=fixture();try{
    const {oauth,calls}=stub();
    const flow=makeConsentFlow({getOAuth:()=>oauth});
    const inactive=await flow.authorize(req('/authorize'),{...env(db),OAUTH_CONSENT_ENABLED:'false'});
    assert.equal(inactive.status,503);
    const start=await flow.authorize(req('/authorize'),env(db));
    assert.equal(start.status,200);
    assert.match(start.headers.get('set-cookie'),/__Host-oauth-consent/);
    const html=await start.text();
    assert.match(html,/Continue to secure sign-in/);
    assert.match(html,/&#60;script&#62;/);
    assert.doesNotMatch(html,/type="password"|name="email"|name="password"/);
    const redirect=await flow.authorize(req('/authorize','POST',
      {handle,decision:'approve',scope:'mcp:read'},
      {origin:'https://auth.whooplens.tech','sec-fetch-site':'same-origin'}),env(db));
    assert.equal(redirect.status,302);
    assert.match(redirect.headers.get('set-cookie'),/__Host-oauth-upstream/);
    assert.equal(new URL(redirect.headers.get('location')).origin,
      'https://evoiwauqplbcecumiwqn.supabase.co');
    assert.equal(calls.complete,0);
    assert.equal(calls.upstream,1);
  }finally{db.close();}
});
test('callback validates browser-bound state, member identity and selected scopes',async()=>{
  const db=fixture();try{
    const {oauth,calls}=stub();let validations=0;
    const flow=makeConsentFlow({getOAuth:()=>oauth,
      verifyIdentity:async({code,verifier})=>{
        validations++;assert.equal(code,'code-123');
        assert.equal(verifier,calls.data.verifier);return A;
      }});
    await flow.authorize(req('/authorize','POST',{handle,decision:'approve',scope:'mcp:read'}),env(db));
    const url='/oauth/upstream/callback?code=code-123&state='+state;
    const request=req(url,'GET',null,{cookie:'__Host-oauth-upstream=private'});
    const approved=await flow.callback(request,env(db));
    assert.equal(approved.status,302);
    assert.equal(approved.headers.get('location'),
      'https://chatgpt.com/callback?code=synthetic-cloudflare-code');
    assert.equal(calls.complete,1);
    assert.equal(validations,1);
    const replay=await flow.callback(request,env(db));
    assert.equal(replay.status,401);
    assert.equal(calls.complete,1);
    const other=req('/oauth/upstream/callback?code=code-123','GET',null,{});
    assert.equal((await flow.callback(other,{...env(db),OAUTH_CONSENT_ENABLED:'false'})).status,503);
  }finally{db.close();}
});
test('denial and cross-origin submissions cannot initiate sign-in',async()=>{
  const db=fixture();try{
    const {oauth,calls}=stub();const flow=makeConsentFlow({getOAuth:()=>oauth});
    const denied=await flow.authorize(req('/authorize','POST',{handle,decision:'deny'}),env(db));
    assert.equal(denied.status,302);
    assert.equal(calls.deny,1);
    for(const headers of [{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'}]){
      assert.equal((await flow.authorize(req('/authorize','POST',
        {handle,decision:'approve',scope:'mcp:read'},headers),env(db))).status,403);
    }
    assert.equal((await flow.authorize(req('/authorize','POST',
      {handle,decision:'approve',scope:'mcp:read',password:'not-allowed'}),env(db))).status,400);
    assert.equal((await flow.authorize(req('/authorize','POST',
      {handle,decision:'deny',scope:'mcp:read'}),env(db))).status,400);
    assert.equal(calls.upstream,0);
    const errorFlow=makeConsentFlow({getOAuth:()=>oauth,errorRedirect:()=> 'https://chatgpt.com/callback?error=access_denied'});
    calls.data={verifier:createVerifier(),grantedScopes:['mcp:read']};
    const er=await errorFlow.callback(req('/oauth/upstream/callback?error=access_denied&state='+state,
      'GET',null,{cookie:'__Host-oauth-upstream=private'}),env(db));
    assert.equal(er.status,302);
    assert.match(er.headers.get('location'),/access_denied/);
    assert.equal(calls.complete,0);
  }finally{db.close();}
});
test('Supabase code exchange checks explicit membership and logs out before granting',async()=>{
  const db=fixture();try{
    const verifier=createVerifier();
    const attempt=async(user,logoutStatus=204)=>{
      const urls=[];const headers=[];
      const result=verifyUpstreamCode({code:'synthetic-auth-code',verifier,env:env(db),
        fetcher:async(url,opts)=>{
          urls.push(url);headers.push(opts);
          if(url.endsWith('/oauth/token'))return response({
            access_token:'t'.repeat(32),refresh_token:'should-never-be-saved'
          });
          if(url.endsWith('/auth/v1/user'))return response({id:user});
          if(url.endsWith('/logout?scope=local'))return new Response(null,{status:logoutStatus});
          throw Error('Unknown host');
        }});
      return {result,urls,headers};
    };
    const good=await attempt(A);
    assert.equal(await good.result,A);
    assert.deepEqual(good.urls.map(s=>new URL(s).pathname),
      ['/auth/v1/oauth/token','/auth/v1/user','/auth/v1/logout']);
    assert.equal(good.headers[0].body.get('grant_type'),'authorization_code');
    assert.equal(good.headers[0].body.get('redirect_uri'),CALLBACK_URI);
    assert.equal(good.headers[0].body.get('code_verifier'),verifier);
    const disabled=await attempt(B);
    await assert.rejects(disabled.result,UpstreamSignInDenied);
    assert.equal(disabled.urls.length,3);
    const notRevoked=await attempt(A,503);
    await assert.rejects(notRevoked.result,UpstreamSignInDenied);
    const malformed=await attempt('not-a-uuid');
    await assert.rejects(malformed.result,UpstreamSignInDenied);
    assert.equal(malformed.urls.length,3);
  }finally{db.close();}
});
test('upstream callback cannot be tricked into issuing other scopes',async()=>{
  const db=fixture();try{
    const {oauth,calls}=stub();calls.data={verifier:createVerifier(),
      grantedScopes:['mcp:read','mcp:write']};
    const flow=makeConsentFlow({getOAuth:()=>oauth,
      verifyIdentity:async()=>{throw Error('should not run');}});
    const response=await flow.callback(req('/oauth/upstream/callback?code=code-123&state='+state,
      'GET',null,{cookie:'__Host-oauth-upstream=private'}),env(db));
    assert.equal(response.status,400);
    assert.equal(calls.complete,0);
  }finally{db.close();}
});
