// Website Life Schedule settings (#128). Served at https://whooplens.tech/settings/ by the
// resource Worker: the same origin as /v1/preferences/life-schedule, so the API's existing
// same-origin check on writes applies unchanged and no CORS is added to the API.
//
// Sign-in (owner-approved design, docs/web-settings-sign-in.md): the page is a public OAuth
// client of https://auth.whooplens.tech using authorization code + S256 PKCE and the existing
// consent screen. Tokens live only in page memory (never localStorage, sessionStorage, cookies
// or the URL). Only the PKCE verifier and state are kept in sessionStorage across the
// sign-in redirect, and they are removed as soon as the callback is read. Sign-out and
// leaving the page revoke the grant at the authorization server.
//
// The browser code below is written as plain functions so Node tests exercise the same source
// that is served (see test/web-settings.test.mjs).

export const SETTINGS_PATH='/settings/';
export const WEB_CLIENT_ID='Ski8wTDIO6CqM746'; // public client registered Nov 1, 2026; no secret
export const AUTH_ORIGIN='https://auth.whooplens.tech';
export const RESOURCE='https://whooplens.tech/mcp';
export const REDIRECT_URI='https://whooplens.tech/settings/';
const LIFE_SCHEDULE_API='/v1/preferences/life-schedule';

// ---- browser helpers (pure; serialized into the page) ----
export function base64Url(bytes){
  let s='';for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function randomToken(cryptoApi){
  const bytes=new Uint8Array(32);cryptoApi.getRandomValues(bytes);return base64Url(bytes);
}
export async function pkceChallenge(verifier,cryptoApi){
  const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
export function authorizeUrl(cfg,challenge,state){
  const u=new URL(cfg.authOrigin+'/authorize');
  u.search=new URLSearchParams({response_type:'code',client_id:cfg.clientId,redirect_uri:cfg.redirectUri,
    scope:'mcp:read',code_challenge:challenge,code_challenge_method:'S256',state,resource:cfg.resource}).toString();
  return u.toString();
}
// Returns {code} only when the callback carries exactly one code and the state matches the
// one this tab stored before redirecting. Anything else is rejected.
export function readCallback(search,expectedState){
  const p=new URLSearchParams(search);
  if(!p.has('code')&&!p.has('error'))return {none:true};
  if(p.has('error'))return {error:'denied'};
  const codes=p.getAll('code'),states=p.getAll('state');
  if(codes.length!==1||states.length!==1||typeof expectedState!=='string'||expectedState.length<20||states[0]!==expectedState)
    return {error:'state'};
  return {code:codes[0]};
}
export function scheduleBody(value){
  if(!['fixed','flexible','unpredictable'].includes(value))throw Error('invalid');
  return JSON.stringify({life_schedule:value,confirmation:'user_selected_life_schedule'});
}

// ---- page controller (runs in the browser) ----
export function settingsApp(cfg,win){
  const doc=win.document,$=id=>doc.getElementById(id);
  const session={access:null,refresh:null}; // memory only
  const KEY='wl-settings-pkce';
  const show=(view,msg)=>{
    for(const v of ['signed-out','signed-in','busy'])$(v).hidden=v!==view;
    $('message').textContent=msg||'';
  };
  const form=fields=>new URLSearchParams(fields).toString();
  async function token(fields){
    const r=await win.fetch(cfg.authOrigin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form(fields),credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(!r.ok)throw Error('token');
    const t=await r.json();
    if(typeof t.access_token!=='string')throw Error('token');
    session.access=t.access_token;session.refresh=typeof t.refresh_token==='string'?t.refresh_token:null;
  }
  function revoke(keepalive){
    // Revoking the refresh token ends the whole grant; with no refresh token, revoke the access token.
    const value=session.refresh||session.access,hint=session.refresh?'refresh_token':'access_token';
    session.access=null;session.refresh=null;
    if(!value)return Promise.resolve();
    return win.fetch(cfg.authOrigin+'/oauth/token',{method:'POST',keepalive,headers:{'content-type':'application/x-www-form-urlencoded'},
      body:form({token:value,token_type_hint:hint,client_id:cfg.clientId}),credentials:'omit',referrerPolicy:'no-referrer'}).catch(()=>{});
  }
  async function api(method,body,retried){
    const r=await win.fetch(cfg.api,{method,headers:{authorization:'Bearer '+session.access,...(body?{'content-type':'application/json'}:{})},body,credentials:'omit',cache:'no-store'});
    if(r.status===401&&!retried&&session.refresh){
      try{await token({grant_type:'refresh_token',refresh_token:session.refresh,client_id:cfg.clientId,resource:cfg.resource});}
      catch{session.access=null;session.refresh=null;throw Object.assign(Error('signed_out'),{status:401});}
      return api(method,body,true);
    }
    let data=null;try{data=await r.json();}catch{data=null;}
    if(!r.ok)throw Object.assign(Error('api'),{status:r.status,code:data?.code});
    return data;
  }
  function explain(e){
    if(e?.status===401){session.access=null;session.refresh=null;return ['signed-out','Your session ended. Sign in again.'];}
    if(e?.code==='feature_disabled')return ['signed-in','Life Schedule is not available right now.'];
    if(e?.status===403)return ['signed-out','Life Schedule settings are only available to active WhoopLens members.'];
    return ['signed-in','Life Schedule could not be reached. Try again shortly. Nothing was changed.'];
  }
  async function load(){
    show('busy','Loading your Life Schedule…');
    try{
      const d=await api('GET');
      for(const input of doc.querySelectorAll('input[name=life_schedule]'))input.checked=input.value===d.life_schedule;
      $('current').textContent=d.explicit?d.life_schedule:'not set (treated as unpredictable)';
      show('signed-in','');
    }catch(e){const [v,m]=explain(e);show(v,m);}
  }
  async function signIn(){
    const verifier=randomToken(win.crypto),state=randomToken(win.crypto);
    win.sessionStorage.setItem(KEY,JSON.stringify({verifier,state}));
    win.location.assign(authorizeUrl(cfg,await pkceChallenge(verifier,win.crypto),state));
  }
  async function save(){
    const picked=doc.querySelector('input[name=life_schedule]:checked');
    if(!picked){show('signed-in','Choose fixed, flexible or unpredictable first.');return;}
    show('busy','Saving…');
    try{const d=await api('PUT',scheduleBody(picked.value));$('current').textContent=d.life_schedule;show('signed-in','Saved. Your Life Schedule is now '+d.life_schedule+'.');}
    catch(e){const [v,m]=explain(e);show(v,m);}
  }
  async function start(){
    $('sign-in').addEventListener('click',()=>{signIn().catch(()=>show('signed-out','Sign-in could not start.'));});
    $('save').addEventListener('click',()=>{save();});
    $('sign-out').addEventListener('click',()=>{revoke(false).then(()=>show('signed-out','Signed out.'));});
    win.addEventListener('pagehide',()=>{revoke(true);});
    let stored=null;
    try{stored=JSON.parse(win.sessionStorage.getItem(KEY)||'null');}catch{stored=null;}
    win.sessionStorage.removeItem(KEY);
    const cb=readCallback(win.location.search,stored?.state);
    if(!cb.none)win.history.replaceState(null,'',cfg.redirectUri); // drop code/state from the address bar and history
    if(cb.error){show('signed-out',cb.error==='denied'?'Sign-in was cancelled.':'Sign-in could not be verified. Start again.');return;}
    if(cb.none){show('signed-out','');return;}
    show('busy','Signing in…');
    try{await token({grant_type:'authorization_code',code:cb.code,redirect_uri:cfg.redirectUri,client_id:cfg.clientId,code_verifier:stored.verifier,resource:cfg.resource});}
    catch{show('signed-out','Sign-in could not be completed. Start again.');return;}
    await load();
  }
  return {start,session,load,save,signIn,revoke};
}

// ---- server side ----
const CLIENT_CONFIG={authOrigin:AUTH_ORIGIN,clientId:WEB_CLIENT_ID,redirectUri:REDIRECT_URI,resource:RESOURCE,api:LIFE_SCHEDULE_API};
export const clientScript=[base64Url,randomToken,pkceChallenge,authorizeUrl,readCallback,scheduleBody,settingsApp]
  .map(f=>f.toString()).join('\n')+`\nsettingsApp(${JSON.stringify(CLIENT_CONFIG)},window).start();`;

const STYLE=`body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#14181f;background:#fafbfc}
h1{font-size:1.4rem}fieldset{border:1px solid #c9d1d9;border-radius:8px;padding:1rem}label{display:block;margin:.4rem 0}
button{font:inherit;padding:.5rem 1rem;margin:.5rem .5rem 0 0;border-radius:6px;border:1px solid #0b6e6e;background:#0b6e6e;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#0b6e6e}#message{min-height:1.5em;font-weight:600}.note{color:#4a5560;font-size:.9rem}`;

function page(enabled){
  const body=enabled?`<p id="message" role="status" aria-live="polite"></p>
<section id="signed-out" hidden><p>Sign in with your WhoopLens member account to view or change your Life Schedule. You approve access on the WhoopLens consent screen.</p>
<button id="sign-in" type="button">Sign in</button></section>
<section id="busy" hidden><p class="note">Please wait…</p></section>
<section id="signed-in" hidden><p>Current Life Schedule: <strong id="current"></strong></p>
<fieldset><legend>Choose your Life Schedule</legend>
<label><input type="radio" name="life_schedule" value="fixed"> Fixed: my days follow a regular timetable</label>
<label><input type="radio" name="life_schedule" value="flexible"> Flexible: my timing varies within a range</label>
<label><input type="radio" name="life_schedule" value="unpredictable"> Unpredictable: my timing changes often</label>
</fieldset>
<button id="save" type="button">Save</button><button id="sign-out" class="secondary" type="button">Sign out</button>
<p class="note">Changes only happen when you press Save. The same setting is used by the WhoopLens Android app and MCP.</p></section>`
    :'<p id="message" role="status">Life Schedule settings are not available right now.</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>WhoopLens · Life Schedule settings</title><style>${STYLE}</style></head>
<body><main><h1>Life Schedule settings</h1>${body}
<p class="note"><a href="https://www.whooplens.tech/privacy/">Privacy</a> · <a href="https://www.whooplens.tech/support/">Support</a></p></main>
${enabled?`<script>${clientScript}</script>`:''}</body></html>`;
}

async function sha256Base64(text){
  const d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  let s='';for(const b of d)s+=String.fromCharCode(b);return btoa(s);
}
let hashes=null;
export async function settingsHeaders(enabled){
  hashes??={script:await sha256Base64(clientScript),style:await sha256Base64(STYLE)};
  const csp=["default-src 'none'",`style-src 'sha256-${hashes.style}'`,
    enabled?`script-src 'sha256-${hashes.script}'`:null,
    enabled?`connect-src 'self' ${AUTH_ORIGIN}`:null,
    "img-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors 'none'"].filter(Boolean).join('; ');
  return {'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':csp,
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY',
    'cross-origin-opener-policy':'same-origin','permissions-policy':'camera=(), microphone=(), geolocation=()'};
}
export async function webSettingsPage(request,env){
  if(request.method!=='GET'&&request.method!=='HEAD')
    return new Response('Method not allowed',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
  const enabled=env?.LIFE_SCHEDULE_ENABLED==='true';
  const headers=await settingsHeaders(enabled);
  return new Response(request.method==='HEAD'?null:page(enabled),{status:200,headers});
}
