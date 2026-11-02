// Website Life Schedule settings (#128): served page, CSP, PKCE helpers and the browser
// controller, driven through a fake window. No network, no real accounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {webSettingsPage,clientScript,authorizeUrl,pkceChallenge,readCallback,scheduleBody,settingsApp,
  WEB_CLIENT_ID,REDIRECT_URI,RESOURCE,AUTH_ORIGIN} from '../src/web-settings.mjs';

const sha=t=>createHash('sha256').update(t).digest('base64');
const get=(env,method='GET')=>webSettingsPage(new Request('https://whooplens.tech/settings/',{method}),env);

test('settings page is served with a hash-pinned CSP, no-store and no framing',async()=>{
  const res=await get({LIFE_SCHEDULE_ENABLED:'true'});
  assert.equal(res.status,200);
  const html=await res.text(),csp=res.headers.get('content-security-policy');
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1],style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal(script,clientScript);
  assert.ok(csp.includes(`script-src 'sha256-${sha(script)}'`));
  assert.ok(csp.includes(`style-src 'sha256-${sha(style)}'`));
  assert.ok(csp.includes(`connect-src 'self' ${AUTH_ORIGIN}`));
  for(const d of ["default-src 'none'","frame-ancestors 'none'","base-uri 'none'","form-action 'none'"])assert.ok(csp.includes(d),d);
  assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval|\*/);
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('x-frame-options'),'DENY');
  assert.equal(res.headers.get('referrer-policy'),'no-referrer');
  assert.doesNotMatch(html,/onclick=|javascript:|localStorage/);
  assert.match(html,/Changes only happen when you press Save/);
});

test('flag off shows "not available" with no script; other methods are rejected',async()=>{
  const off=await get({LIFE_SCHEDULE_ENABLED:'false'});
  const html=await off.text();
  assert.match(html,/not available right now/);assert.doesNotMatch(html,/<script>/);
  assert.doesNotMatch(off.headers.get('content-security-policy'),/script-src|connect-src/);
  assert.equal((await get({LIFE_SCHEDULE_ENABLED:'true'},'POST')).status,405);
  assert.equal((await get({LIFE_SCHEDULE_ENABLED:'true'},'HEAD')).status,200);
});

test('resource Worker routes /settings/ on the apex before the OAuth gate',()=>{
  const src=readFileSync(new URL('../oauth/resource/src/index.mjs',import.meta.url),'utf8');
  const route=src.indexOf('webSettingsPage(request,env)'),gate=src.indexOf('OAUTH_RESOURCE_ENABLED!=="true")\n      return Response.json');
  assert.ok(route>0&&gate>route);
  assert.match(src,/requestUrl\.origin==='https:\/\/whooplens\.tech'&&\(path===SETTINGS_PATH/);
});

test('authorize URL uses the registered public client, S256 PKCE, mcp:read and the MCP resource',async()=>{
  // S256 = base64url(SHA-256(verifier)) without padding, checked against node:crypto.
  const v='dBjftJeZ4CVP-mJ0z0dfQ5D3cKxcCBVJhJu6zdpYv3E';
  assert.equal(await pkceChallenge(v,webcrypto),createHash('sha256').update(v).digest('base64url'));
  const u=new URL(authorizeUrl({authOrigin:AUTH_ORIGIN,clientId:WEB_CLIENT_ID,redirectUri:REDIRECT_URI,resource:RESOURCE},'CH','ST'));
  assert.equal(u.origin+u.pathname,'https://auth.whooplens.tech/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams),{response_type:'code',client_id:WEB_CLIENT_ID,redirect_uri:'https://whooplens.tech/settings/',
    scope:'mcp:read',code_challenge:'CH',code_challenge_method:'S256',state:'ST',resource:'https://whooplens.tech/mcp'});
});

test('callback is accepted only with one code and the exact stored state',()=>{
  const st='s'.repeat(43);
  assert.deepEqual(readCallback('',st),{none:true});
  assert.deepEqual(readCallback('?code=abc&state='+st,st),{code:'abc'});
  assert.deepEqual(readCallback('?code=abc&state=other',st),{error:'state'});
  assert.deepEqual(readCallback('?code=abc&state='+st,undefined),{error:'state'});
  assert.deepEqual(readCallback('?code=a&code=b&state='+st,st),{error:'state'});
  assert.deepEqual(readCallback('?code=a&state='+st+'&state='+st,st),{error:'state'});
  assert.deepEqual(readCallback('?error=access_denied&state='+st,st),{error:'denied'});
  assert.equal(scheduleBody('flexible'),'{"life_schedule":"flexible","confirmation":"user_selected_life_schedule"}');
  assert.throws(()=>scheduleBody('nocturnal'));
});

// Minimal browser double: elements, radios, storage, history, fetch and events.
function fakeWindow(search,stored){
  const els={},listeners={},calls=[],storage=new Map(stored?[['wl-settings-pkce',JSON.stringify(stored)]]:[]),local=new Map();
  const el=id=>els[id]??={id,hidden:false,textContent:'',handlers:{},addEventListener(t,f){this.handlers[t]=f;}};
  const radios=['fixed','flexible','unpredictable'].map(value=>({value,checked:false}));
  let history=[],assigned=null,responses=[];
  const win={
    document:{getElementById:el,querySelectorAll:()=>radios,querySelector:()=>radios.find(r=>r.checked)??null},
    location:{search,assign:u=>{assigned=u;}},
    history:{replaceState:(_s,_t,u)=>history.push(u)},
    sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    localStorage:{getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v)},
    crypto:webcrypto,
    addEventListener:(t,f)=>{listeners[t]=f;},
    fetch:async(url,init={})=>{calls.push({url,init});const next=responses.shift();if(!next)throw Error('unexpected fetch '+url);return next(url,init);}
  };
  return {win,els,el,radios,calls,storage,local,listeners,get history(){return history;},get assigned(){return assigned;},reply:(...r)=>responses.push(...r)};
}
const json=(body,status=200)=>()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const cfg={authOrigin:AUTH_ORIGIN,clientId:WEB_CLIENT_ID,redirectUri:REDIRECT_URI,resource:RESOURCE,api:'/v1/preferences/life-schedule'};
const tick=()=>new Promise(r=>setTimeout(r,0));

test('sign-in, read, explicit save, refresh on 401 and sign-out keep tokens in memory only',async()=>{
  const state='S'.repeat(43),verifier='V'.repeat(43);
  const w=fakeWindow('?code=CODE1&state='+state,{verifier,state});
  w.reply(json({access_token:'AT1',refresh_token:'RT1',token_type:'bearer'}),json({life_schedule:'unpredictable',explicit:false,revision:null}));
  const app=settingsApp(cfg,w.win);
  await app.start();
  // Code exchange: exact form, public client, the stored verifier, no credentials.
  const ex=w.calls[0];
  assert.equal(ex.url,'https://auth.whooplens.tech/oauth/token');assert.equal(ex.init.credentials,'omit');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ex.init.body)),{grant_type:'authorization_code',code:'CODE1',redirect_uri:REDIRECT_URI,client_id:WEB_CLIENT_ID,code_verifier:verifier,resource:RESOURCE});
  // The callback query is removed and the PKCE material deleted before anything else.
  assert.deepEqual(w.history,[REDIRECT_URI]);assert.equal(w.storage.size,0);
  assert.equal(w.calls[1].init.headers.authorization,'Bearer AT1');assert.equal(w.calls[1].init.method,'GET');
  assert.equal(w.el('current').textContent,'not set (treated as unpredictable)');
  assert.equal(w.el('signed-in').hidden,false);
  // Nothing persisted outside memory.
  assert.equal(w.storage.size,0);assert.equal(w.local.size,0);
  assert.deepEqual(app.session,{access:'AT1',refresh:'RT1'});
  // Save needs a selection; then sends the exact body. A 401 refreshes once and retries.
  assert.equal(w.radios[2].checked,true); // the current value is pre-selected
  for(const r of w.radios)r.checked=false;
  await app.save();assert.match(w.el('message').textContent,/Choose fixed, flexible or unpredictable/);
  assert.equal(w.calls.length,2); // nothing sent
  w.radios[1].checked=true;
  w.reply(json({error:'expired'},401),json({access_token:'AT2',refresh_token:'RT2'}),json({life_schedule:'flexible',explicit:true,revision:'r1'}));
  await app.save();
  const [put1,refresh,put2]=w.calls.slice(2);
  assert.equal(put1.init.method,'PUT');assert.equal(put1.init.body,'{"life_schedule":"flexible","confirmation":"user_selected_life_schedule"}');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(refresh.init.body)),{grant_type:'refresh_token',refresh_token:'RT1',client_id:WEB_CLIENT_ID,resource:RESOURCE});
  assert.equal(put2.init.headers.authorization,'Bearer AT2');
  assert.match(w.el('message').textContent,/Saved\. Your Life Schedule is now flexible/);
  // Sign-out revokes the grant through its refresh token and clears memory.
  w.reply(()=>new Response(null,{status:200}));
  w.el('sign-out').handlers.click();await tick();
  const rev=w.calls.at(-1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(rev.init.body)),{token:'RT2',token_type_hint:'refresh_token',client_id:WEB_CLIENT_ID});
  assert.deepEqual(app.session,{access:null,refresh:null});
  assert.equal(w.el('signed-out').hidden,false);
});

test('a forged or replayed callback never reaches the token endpoint',async()=>{
  for(const [search,stored] of [['?code=X&state=ATTACKER','S'.repeat(43)],['?code=X&state='+'S'.repeat(43),null]]){
    const w=fakeWindow(search,stored?{verifier:'V'.repeat(43),state:stored}:null);
    await settingsApp(cfg,w.win).start();
    assert.equal(w.calls.length,0);
    assert.match(w.el('message').textContent,/could not be verified/);
    assert.deepEqual(w.history,[REDIRECT_URI]);
  }
});

test('sign-in stores only the PKCE verifier and state, and sends the S256 challenge',async()=>{
  const w=fakeWindow('',null);
  const app=settingsApp(cfg,w.win);
  await app.start();
  await app.signIn();
  const saved=JSON.parse(w.storage.get('wl-settings-pkce'));
  assert.deepEqual(Object.keys(saved).sort(),['state','verifier']);
  const u=new URL(w.assigned);
  assert.equal(u.searchParams.get('state'),saved.state);
  assert.equal(u.searchParams.get('code_challenge'),await pkceChallenge(saved.verifier,webcrypto));
  assert.ok(saved.verifier.length>=43);
});

test('inactive members, disabled feature and ended sessions get clear states',async()=>{
  const st='S'.repeat(43);
  for(const [resp,view,msg] of [[json({code:'not_authorized'},403),'signed-out',/only available to active WhoopLens members/],
    [json({code:'feature_disabled'},503),'signed-in',/not available right now/],
    [json({error:'x'},401),'signed-out',/session ended/]]){
    const w=fakeWindow('?code=C&state='+st,{verifier:'V'.repeat(43),state:st});
    w.reply(json({access_token:'AT'}),resp);
    const app=settingsApp(cfg,w.win);await app.start();
    assert.equal(w.el(view).hidden,false,String(msg));assert.match(w.el('message').textContent,msg);
  }
  // Leaving the page revokes whatever this tab holds (no refresh token: the access token).
  const w=fakeWindow('?code=C&state='+st,{verifier:'V'.repeat(43),state:st});
  w.reply(json({access_token:'AT9'}),json({life_schedule:'fixed',explicit:true,revision:'r'}),()=>new Response(null));
  const app=settingsApp(cfg,w.win);await app.start();
  w.listeners.pagehide();await tick();
  const rev=w.calls.at(-1);
  assert.equal(rev.init.keepalive,true);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(rev.init.body)),{token:'AT9',token_type_hint:'access_token',client_id:WEB_CLIENT_ID});
});
