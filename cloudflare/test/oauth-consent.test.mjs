import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {makeConsentFlow} from '../oauth/auth-server/src/consent-flow.mjs';
import {reserveLoginAttempt} from '../oauth/auth-server/src/rate-limit.mjs';
import {verifyInvitedSignIn,SignInDenied} from '../oauth/auth-server/src/login.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key=randomBytes(32).toString('base64url');
function dbFixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_oauth_login_limits.sql',import.meta.url),'utf8'));
  for(const id of [A,B])
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(A);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,0)').run(B);
  return {
    sqlite,close:()=>sqlite.close(),
    prepare(sql){let args=[];return {bind(...values){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;}};}
  };
}
const env=db=>({DB:db,SUPABASE_PUBLIC_KEY:'synthetic-publishable',AUTH_RATE_HMAC_KEY:key,
  OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true'});
const req=(method,body)=>new Request('https://auth.whooplens.tech/authorize',{
  method,headers:method==='POST'?{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'198.51.100.1'}:{},
  body:method==='POST'?new URLSearchParams(body):undefined
});
function stub(){
  const seen={begin:0,approved:0,denied:0,complete:0};
  const original={scope:['mcp:read','offline_access']};
  const oauth={
    async parseAuthRequest(){return original;},
    async describeConsent(){return {clientName:'<img onerror=alert(1)>',redirectHost:'chatgpt.com',
      clientDomain:'client.example',scope:original.scope};},
    async beginConsent(){seen.begin++;return {handle:'A'.repeat(43),
      headers:new Headers({'set-cookie':'__Host-oauth-consent=synthetic; Secure; HttpOnly'})};},
    async approveConsent(_request,handle,{scope}){
      assert.equal(handle,'A'.repeat(43));assert.deepEqual(scope,['mcp:read']);
      seen.approved++;return {request:original,headers:new Headers({'set-cookie':'__Host-oauth-consent=; Max-Age=0'})};},
    async denyConsent(){seen.denied++;return {headers:new Headers({location:'https://chatgpt.com/denied'})};},
    async completeAuthorization({userId,scope,props}){
      seen.complete++;assert.equal(userId,A);assert.deepEqual(scope,['mcp:read']);
      assert.deepEqual(props,{userId:A});return {redirectTo:'https://chatgpt.com/callback?code=fake'};}
  };return {seen,oauth};
}
test('CSRF-bound consent is escaped, explicit, and disabled until both switches enabled',async()=>{
  const db=dbFixture();try{
    const {seen,oauth}=stub();const handler=makeConsentFlow({getOAuth:()=>oauth});
    assert.equal((await handler(req('GET'),{...env(db),OAUTH_CONSENT_ENABLED:'false'})).status,503);
    const response=await handler(req('GET'),env(db));
    assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie'),/__Host-oauth-consent/);
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const html=await response.text();
    assert.match(html,/name="handle"/);
    assert.match(html,/Sign in and allow/);
    // Cancel is a separate form, not one that includes the password field.
    assert.match(html,/<\/form><form method="post" action="\/authorize">/);
    assert.doesNotMatch(html,/<img onerror/);
    assert.match(html,/&#60;img/);
    assert.equal(seen.complete,0);
  }finally{db.close();}
});
test('authorization requires approved scopes, verified login and permits cancellation',async()=>{
  const db=dbFixture();try{
    const {seen,oauth}=stub();
    let signins=0;
    const handler=makeConsentFlow({getOAuth:()=>oauth,rateLimit:async()=>true,
      signIn:async({email,password})=>{signins++;assert.equal(email,'test@example.com');
        assert.equal(password,'sample-only');return A;}});
    const params={handle:'A'.repeat(43),scope:'mcp:read',decision:'approve',email:'test@example.com',password:'sample-only'};
    const response=await handler(req('POST',params),env(db));
    assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://chatgpt.com/callback?code=fake');
    const denied=await handler(req('POST',{handle:'A'.repeat(43),decision:'deny'}),env(db));
    assert.equal(denied.status,302);assert.equal(seen.denied,1);
    assert.equal(signins,1);assert.equal(seen.approved,1);assert.equal(seen.complete,1);
    for(const scope of ['offline_access','mcp:write']){
      const bad=await handler(req('POST',{...params,scope}),env(db));
      assert.notEqual(bad.status,302);
    }
    assert.equal(seen.complete,1);
  }finally{db.close();}
});
test('Supabase password credentials are checked against /auth/v1/user and active invite',async()=>{
  const db=dbFixture();try{
    const responses=[new Response(JSON.stringify({access_token:'t'.repeat(32),user:{id:A}}),{status:200}),
      new Response(JSON.stringify({id:A}),{status:200}),
      new Response(null,{status:204})];
    let requests=0;
    const identity=await verifyInvitedSignIn({email:'test@example.com',password:'not-stored',env:env(db),
      fetcher:async(url,options)=>{
        requests++;
        if(requests===1){assert.match(url,/grant_type=password/);
          assert.equal(JSON.parse(options.body).password,'not-stored');}
        else if(requests===2){assert.match(url,/\/auth\/v1\/user/);assert.match(options.headers.authorization,/^Bearer /);}
        else{assert.match(url,/\/auth\/v1\/logout\?scope=local/);assert.equal(options.method,'POST');}
        return responses.shift();
      }});
    assert.equal(identity,A);assert.equal(requests,3);
    const disabled=[new Response(JSON.stringify({access_token:'s'.repeat(32),user:{id:B}}),{status:200}),
      new Response(JSON.stringify({id:B}),{status:200}),
      new Response(null,{status:204})];
    await assert.rejects(verifyInvitedSignIn({email:'test@example.com',password:'synthetic',env:env(db),
      fetcher:async()=>disabled.shift()}),SignInDenied);
    await assert.rejects(verifyInvitedSignIn({email:'test@example.com',password:'synthetic',env:env(db),
      fetcher:async()=>new Response('Unauthorized',{status:401})}),SignInDenied);
  }finally{db.close();}
});
test('atomic D1 login limits enforce five tries per IP and email in 15 minutes without storing identifiers',async()=>{
  const db=dbFixture();try{
    const e=env(db),now=()=>Date.parse('2026-10-11T13:00:00Z');
    const request=new Request('https://auth.whooplens.tech/authorize',
      {headers:{'cf-connecting-ip':'198.51.100.1'}});
    for(let i=0;i<5;i++)assert.equal(await reserveLoginAttempt(request,'test@example.com',e,{now}),true);
    assert.equal(await reserveLoginAttempt(request,'test@example.com',e,{now}),false);
    assert.equal(await reserveLoginAttempt(request,'other@example.com',e,{now}),false);
    const rows=db.sqlite.prepare('SELECT * FROM oauth_login_attempts').all();
    assert.equal(rows.length,2);
    assert.doesNotMatch(JSON.stringify(rows),/test@example.com|198.51.100.1/);
    assert.equal(await reserveLoginAttempt(request,'test@example.com',e,{now:()=>now()+900000}),true);
    assert.equal(await reserveLoginAttempt(new Request('https://auth.whooplens.tech/authorize'),
      'test@example.com',e,{now}),false);
  }finally{db.close();}
});

test('cross-origin and cross-site POSTs fail before OAuth consent is consumed',async()=>{
  const db=dbFixture();try{
    const {oauth,seen}=stub();
    let signins=0;
    const handler=makeConsentFlow({getOAuth:()=>oauth,rateLimit:async()=>true,
      signIn:async()=>{signins++;return A;}});
    const body={handle:'A'.repeat(43),scope:'mcp:read',decision:'approve',
      email:'test@example.com',password:'synthetic-only'};
    const tests=[
      {origin:'https://attacker.invalid'},
      {'sec-fetch-site':'cross-site'},
      {origin:'null'},
      {'sec-fetch-site':'same-site'}
    ];
    for(const headers of tests){
      const request=new Request('https://auth.whooplens.tech/authorize',{
        method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},
        body:new URLSearchParams(body)
      });
      const response=await handler(request,env(db));
      assert.equal(response.status,403);
    }
    const wrongHost=new Request('https://other.invalid/authorize',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams(body)
    });
    assert.equal((await handler(wrongHost,env(db))).status,403);
    assert.equal(seen.approved,0);
    assert.equal(signins,0);
  }finally{db.close();}
});

test('Cancel never accepts a form containing email, password or scope',async()=>{
  const db=dbFixture();try{
    const {oauth,seen}=stub();
    const handler=makeConsentFlow({getOAuth:()=>oauth});
    const h='A'.repeat(43);
    for(const extra of [{email:'x@example.com'},{password:'synthetic'},{scope:'mcp:read'}]){
      const bad=await handler(req('POST',{handle:h,decision:'deny',...extra}),env(db));
      assert.equal(bad.status,400);
    }
    assert.equal(seen.denied,0);
    assert.equal((await handler(req('POST',{handle:h,decision:'deny'}),env(db))).status,302);
    assert.equal(seen.denied,1);
  }finally{db.close();}
});

test('temporary Supabase session must be logged out before an OAuth user ID is accepted',async()=>{
  const db=dbFixture();try{
    const result=async(validLogout)=>{
      let n=0;
      return verifyInvitedSignIn({email:'test@example.com',password:'synthetic-only',
        env:env(db),fetcher:async(url,opts)=>{
          n++;
          if(n===1)return new Response(JSON.stringify({access_token:'t'.repeat(32),user:{id:A}}));
          if(n===2)return new Response(JSON.stringify({id:A}));
          assert.match(url,/\/auth\/v1\/logout\?scope=local/);
          assert.equal(opts.method,'POST');
          return new Response(null,{status:validLogout?204:503});
        }});
    };
    assert.equal(await result(true),A);
    await assert.rejects(result(false),SignInDenied);
  }finally{db.close();}
});
