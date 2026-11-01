// WHOOP connect browser binding. Off unless WHOOP_CONNECT_BROWSER_BINDING is
// exactly "true" (requires migration 0026).
//
// Without binding, the WHOOP authorization link returned by connect_whoop works
// for whoever opens it: if a member forwards it, the recipient's WHOOP account is
// saved under that member. With binding:
//   1. connect_whoop returns https://whooplens.tech/api/whoop/start?state=...
//   2. GET shows a confirmation page and changes nothing (safe for link previews).
//   3. POST (same-origin form) records SHA-256 of a fresh browser nonce on the
//      pending state, sets it as a __Host- cookie and redirects to WHOOP. A state
//      can be confirmed only once.
//   4. The callback consumes the state only when that cookie is presented.
// A leaked or replayed link therefore cannot be completed from another browser,
// and the confirmation page warns anyone who was sent the link not to continue.
import {readBounded} from './bounded-body.mjs';
import {activeMembership} from './storage.mjs';
import {whoopAuthorizeUrl,whoopBrowserBinding,sha256Hex,WHOOP_START,WHOOP_BROWSER_COOKIE} from './whoop-oauth.mjs';
export {WHOOP_START};

const ORIGIN='https://whooplens.tech';
const STATE=/^[A-Za-z0-9_-]{32,512}$/;
function nonce(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
const clearCookie=WHOOP_BROWSER_COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
const baseHeaders={
  'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://api.prod.whoop.com; base-uri 'none'; frame-ancestors 'none'"
};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body,status=200,extra={}){
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · WhoopLens</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071a1c;color:#e8f6f5;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:30rem;margin:1.5rem;padding:1.75rem;border-radius:1.25rem;background:rgba(255,255,255,.06);border:1px solid rgba(94,234,212,.25)}
h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:.6rem 0}.warn{color:#fde68a}
button{margin-top:1rem;width:100%;padding:.8rem 1rem;border:0;border-radius:.8rem;background:#2dd4bf;color:#04201f;font-weight:700;font-size:1rem;cursor:pointer}
</style></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
  return new Response(html,{status,headers:{...baseHeaders,'content-type':'text/html; charset=utf-8',...extra}});
}
export const whoopResultPage=(title,message,status=200,{clear=false}={})=>
  page(title,`<p>${escape(message)}</p>`,status,clear?{'set-cookie':clearCookie}:{});

const expired=()=>whoopResultPage('Link expired','This WHOOP connection link is invalid, expired or already used. Ask WhoopLens to connect WHOOP again from your own chat.',400,{clear:true});

async function pendingState(db,state,now){
  const row=await db.prepare('SELECT user_id,browser_hash FROM whoop_oauth_states WHERE state_hash=?1 AND expires_at>?2')
    .bind(await sha256Hex(state),new Date(now).toISOString()).first();
  if(!row?.user_id||!await activeMembership(db,row.user_id))return null;
  return row;
}

export async function whoopStartHttp(request,env,{now=Date.now}={}){
  try{
    if(env?.WHOOP_OAUTH_ENABLED!=='true'||!whoopBrowserBinding(env)||!env?.DB)
      return whoopResultPage('Unavailable','WHOOP connection is not available right now.',503);
    const url=new URL(request.url);
    if(url.origin!==ORIGIN||url.pathname!==WHOOP_START)return whoopResultPage('Not found','Not found.',404);
    if(request.method==='GET'){
      const states=url.searchParams.getAll('state');
      if(states.length!==1||!STATE.test(states[0]))return expired();
      const row=await pendingState(env.DB,states[0],now());
      if(!row||row.browser_hash)return expired();
      return page('Connect your WHOOP account',
        `<p>This links a WHOOP account to the WhoopLens member who asked for this link in their own chat.</p>
<p class="warn"><strong>If someone sent you this link, do not continue.</strong> Continuing would give them access to your WHOOP data.</p>
<form method="post" action="${WHOOP_START}"><input type="hidden" name="state" value="${escape(states[0])}"><button type="submit">Continue to WHOOP</button></form>`);
    }
    if(request.method!=='POST')return whoopResultPage('Not allowed','Method not allowed.',405);
    const origin=request.headers.get('origin');
    if(origin!==null&&origin!==ORIGIN)return whoopResultPage('Not allowed','Please continue from the WhoopLens page.',403);
    if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))return expired();
    const body=await readBounded(request,2048);
    if(body.error)return expired();
    const form=new URLSearchParams(body.text);
    if([...form.keys()].some(k=>k!=='state')||form.getAll('state').length!==1)return expired();
    const state=form.get('state');
    if(!STATE.test(state))return expired();
    const at=now();
    const row=await pendingState(env.DB,state,at);
    if(!row)return expired();
    const browser=nonce();
    const write=await env.DB.prepare('UPDATE whoop_oauth_states SET browser_hash=?1 WHERE state_hash=?2 AND browser_hash IS NULL AND expires_at>?3')
      .bind(await sha256Hex(browser),await sha256Hex(state),new Date(at).toISOString()).run();
    if(write?.meta?.changes!==1)
      return whoopResultPage('Link already used','This WHOOP connection link was already opened. Ask WhoopLens for a new link from your own chat.',400,{clear:true});
    return new Response(null,{status:303,headers:{...baseHeaders,location:whoopAuthorizeUrl(state,env),
      'set-cookie':`${WHOOP_BROWSER_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`}});
  }catch{
    return whoopResultPage('Unavailable','WHOOP connection could not be started. Try again later.',503);
  }
}
