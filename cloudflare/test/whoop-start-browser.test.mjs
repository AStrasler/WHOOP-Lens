// Real-browser regression test for the WHOOP browser-binding flow (PR #122 follow-up).
// Production on Nov 1 2026: Chrome submitted the confirmation form with `Origin: null`
// because the page was served with `Referrer-Policy: no-referrer`, and the start
// endpoint rejected it with "Not allowed". Only a real browser reproduces that header.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createWhoopAuthorization,acceptWhoopCallback} from '../src/whoop-oauth.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {d1Database} from './d1-sqlite.mjs';
import {probeWhoopStart,browserProbeAvailable} from './fixtures/whoop-start-browser-probe.mjs';

const chrome=process.env.WHOOP_TEST_CHROME||
  (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':
   process.platform==='linux'?'/usr/bin/google-chrome':'');
const available=!!chrome&&existsSync(chrome)&&browserProbeAvailable(chrome);
// CI sets WHOOP_REQUIRE_BROWSER_TESTS=1 so a missing browser fails instead of skipping.
if(process.env.WHOOP_REQUIRE_BROWSER_TESTS==='1'&&!available)
  throw Error('Browser tests required but Chrome or openssl is unavailable (Chrome: '+(chrome||'unset')+')');

const MEMBER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env={
  WHOOP_CLIENT_ID:'synthetic-client',WHOOP_CLIENT_SECRET:'synthetic-secret',
  WHOOP_REDIRECT_URI:'https://whooplens.tech/api/whoop/callback',
  WHOOP_TOKEN_AES256_KEY:randomBytes(32).toString('base64url'),WHOOP_LENS_DEVELOPER_USER_ID:MEMBER,
  MIGRATION_API_ENABLED:'true',WHOOP_OAUTH_ENABLED:'true',WHOOP_CONNECT_BROWSER_BINDING:'true'
};
function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0001_initial.sql','0002_enforce_seat_limits.sql','0008_whoop_credential_revocations.sql','0026_whoop_oauth_browser_binding.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(MEMBER,MEMBER);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(MEMBER);
  return {sqlite,...d1Database(sqlite)};
}
// Stands in for whooplens.tech (the real router) and WHOOP (authorize + token).
function world(db,{whoopRedirects=true}={}){
  const tokenCalls=[];
  const router=createStagingRouter({whoopCallback:(d,url,e,options)=>acceptWhoopCallback(d,url,e,{...options,
    fetcher:async(url,init)=>{tokenCalls.push(url);return Response.json({access_token:'synthetic-access',
      refresh_token:'synthetic-refresh',expires_in:3600,scope:'offline'});}})});
  const whoopAuthorize=[];
  const handle=async request=>{
    const url=new URL(request.url);
    if(url.origin==='https://api.prod.whoop.com'&&url.pathname==='/oauth/oauth2/auth'){
      whoopAuthorize.push(url);
      // Like real WHOOP, authorize hands off to a separate sign-in host. CSP form-action
      // would block this hop if it were part of the form submission's redirect chain.
      const login=new URL('https://id.whoop.com/login');
      login.searchParams.set('return_to',url.toString());
      return new Response(null,{status:302,headers:{location:login.toString()}});
    }
    if(url.origin==='https://id.whoop.com'&&url.pathname==='/login'){
      if(!whoopRedirects)return new Response('<h1>WHOOP sign-in</h1>',{headers:{'content-type':'text/html'}});
      // Simulate the member signing in and approving at WHOOP.
      const authorize=new URL(url.searchParams.get('return_to'));
      const back=new URL(authorize.searchParams.get('redirect_uri'));
      back.searchParams.set('code','synthetic-whoop-code');
      back.searchParams.set('state',authorize.searchParams.get('state'));
      return new Response(null,{status:302,headers:{location:back.toString()}});
    }
    return router(request,{...env,DB:db});
  };
  return {handle,whoopAuthorize,tokenCalls};
}

test('real Chrome completes the WHOOP browser-binding flow: confirm, redirect, callback',
  {skip:!available&&'Chrome not available',timeout:60000},async()=>{
    const db=database();
    try{
      const start=await createWhoopAuthorization(db,MEMBER,env);
      const startUrl=new URL(start.authorization_url);
      assert.equal(startUrl.origin+startUrl.pathname,'https://whooplens.tech/api/whoop/start');
      const state=startUrl.searchParams.get('state');
      const {handle,whoopAuthorize,tokenCalls}=world(db);
      const run=await probeWhoopStart(chrome,{startUrl:startUrl.toString(),handle,
        done:'location.pathname==="/api/whoop/callback"&&!!document.querySelector("h1")'});

      // Confirmation page carries the state in a same-origin POST form.
      assert.equal(run.confirmation.title,'Connect your WHOOP account');
      assert.match(run.confirmation.text,/If someone sent you this link, do not continue/);
      assert.equal(run.confirmation.action,'/api/whoop/start');
      assert.equal(run.confirmation.method,'post');
      assert.equal(run.confirmation.state,state);

      // What the browser actually sent when the member clicked Continue.
      const post=run.requests.find(r=>r.method==='POST');
      assert.ok(post,'browser submitted the form');
      assert.equal(post.secFetchSite,'same-origin');
      assert.equal(post.origin,'https://whooplens.tech','a same-origin form post must carry the real origin, not "null"');
      assert.equal(new URLSearchParams(post.body).get('state'),state,'state survives the form submission');
      assert.equal(post.status,200,'the POST answers with the Opening WHOOP page, not a redirect');

      // WHOOP authorization started with the same state and our registered redirect.
      assert.equal(whoopAuthorize.length,1);
      assert.equal(whoopAuthorize[0].searchParams.get('state'),state);
      assert.equal(whoopAuthorize[0].searchParams.get('redirect_uri'),'https://whooplens.tech/api/whoop/callback');
      const atWhoop=run.requests.find(r=>r.url.startsWith('https://api.prod.whoop.com/'));
      assert.equal(atWhoop.referer,null,'the state-bearing start URL is never sent to WHOOP as a referrer');
      assert.ok(run.requests.some(r=>r.url.startsWith('https://id.whoop.com/login')),'WHOOP hand-off to its sign-in host was not blocked');

      // The callback carried the browser-binding cookie and completed.
      const callback=run.requests.find(r=>r.url.startsWith('https://whooplens.tech/api/whoop/callback'));
      assert.ok(callback,'WHOOP redirected back to the callback');
      assert.match(callback.cookie||'',/__Host-wl_whoop=[A-Za-z0-9_-]{43}/);
      assert.equal(callback.status,200);
      assert.equal(run.result.title,'WHOOP connected');
      assert.equal(tokenCalls.length,1);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM whoop_connections WHERE user_id=?').get(MEMBER).c,1);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM whoop_oauth_states').get().c,0);
    }finally{db.sqlite.close();}
  });

test('real Chrome: after one browser confirms, a cookieless replay of the callback is refused',
  {skip:!available&&'Chrome not available',timeout:60000},async()=>{
    const db=database();
    try{
      const start=await createWhoopAuthorization(db,MEMBER,env);
      const state=new URL(start.authorization_url).searchParams.get('state');
      // Browser 1 confirms and reaches WHOOP, then stops (the member never finishes there).
      const first=world(db,{whoopRedirects:false});
      const run=await probeWhoopStart(chrome,{startUrl:start.authorization_url,handle:first.handle,
        done:'location.host==="id.whoop.com"'});
      assert.equal(first.whoopAuthorize.length,1);
      assert.equal(run.requests.find(r=>r.method==='POST')?.status,200);
      assert.equal(run.result.title,'WHOOP sign-in');
      // Anyone else holding the callback URL (no cookie from browser 1) presents it.
      const second=world(db);
      const leaked='https://whooplens.tech/api/whoop/callback?'+new URLSearchParams({state,code:'leaked-code'});
      const response=await second.handle(new Request(leaked));
      assert.equal(response.status,400);
      assert.match(await response.text(),/same browser/);
      assert.equal(second.tokenCalls.length,0);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM whoop_connections').get().c,0);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM whoop_oauth_states').get().c,1,'state is not consumed');
    }finally{db.sqlite.close();}
  });
