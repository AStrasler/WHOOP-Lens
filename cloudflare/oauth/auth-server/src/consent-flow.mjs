import {rejectEarlyData} from '../../../src/early-data.mjs';
import {consentPage,noStoreHeaders,unavailable} from '../../consent.mjs';
import {createVerifier,checkUpstreamConfig,upstreamAuthorizationUrl,verifyUpstreamCode} from './upstream.mjs';
import {logOAuthStage,logAuthorizationFailure} from './oauth-diagnostics.mjs';
const SCOPES=new Set(['mcp:read','offline_access']);
const ORIGIN='https://auth.whooplens.tech';
const CALLBACK_PATH='/oauth/upstream/callback';
const oauthError=(status=400,cleanup)=>{
  const headers=new Headers(cleanup);
  for(const [key,value] of Object.entries(noStoreHeaders()))headers.set(key,value);
  return new Response('Authorization unavailable',{status,headers});
};
const allowedSelection=(selected,original)=>
  Array.isArray(selected)&&selected.length>=1&&selected.length<=2&&
  selected.includes('mcp:read')&&new Set(selected).size===selected.length&&
  selected.every(s=>SCOPES.has(s)&&original.includes(s));
async function readForm(request){
  const type=(request.headers.get('content-type')||'').trim();
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(type))return null;
  if(Number(request.headers.get('content-length'))>2048)return null;
  const text=await request.text();
  if(text.length>2048)return null;
  const data=new URLSearchParams(text);
  if([...data.keys()].some(k=>!['handle','decision','scope'].includes(k)))return null;
  if(['handle','decision'].some(k=>data.getAll(k).length!==1))return null;
  return data;
}
function checkBrowserPost(request){
  const origin=request.headers.get('origin');
  const fetchSite=request.headers.get('sec-fetch-site');
  // A same-origin form can be reported as same-site. Cross-site posts stay
  // rejected. The literal Origin "null" stays rejected; only a missing Origin
  // header is treated as absent.
  return new URL(request.url).origin===ORIGIN &&
    (origin===null||origin===ORIGIN) &&
    (fetchSite===null||fetchSite==='same-origin'||fetchSite==='same-site'||fetchSite==='none');
}
export function makeConsentFlow({
  getOAuth,checkConfig=checkUpstreamConfig,verifyIdentity=verifyUpstreamCode,
  startUrl=upstreamAuthorizationUrl,pkceVerifier=createVerifier,
  errorRedirect=()=>null
}={}){
  if(typeof getOAuth!=='function')throw Error('Official OAuth provider required');

  async function authorize(request,env){
    const early=rejectEarlyData(request);if(early)return early;
    if(env?.OAUTH_SERVER_ENABLED!=='true'||env?.OAUTH_CONSENT_ENABLED!=='true')
      return unavailable();
    if(new URL(request.url).origin!==ORIGIN)return oauthError(403);
    const oauth=getOAuth(env);
    if(request.method==='GET'){
      let stage='authorize_request';
      try{
        const original=await oauth.parseAuthRequest(request);
        if(!Array.isArray(original.scope)||!allowedSelection(original.scope,original.scope)){
          logAuthorizationFailure(env,'authorize_scope',null,'scope_rejected');
          return oauthError();
        }
        stage='consent_description';
        const description=await oauth.describeConsent(original);
        stage='consent_session';
        const bind=await oauth.beginConsent(original);
        const headers=new Headers(bind.headers);
        for(const [key,value] of Object.entries(noStoreHeaders('text/html; charset=utf-8')))
          headers.set(key,value);
        // Form navigation POSTs from no-referrer documents use Origin: null.
        // Only this HTML consent document needs same-origin referrer policy;
        // keep strict Origin validation and one-time consent cookies intact.
        headers.set('referrer-policy','same-origin');
        return new Response(consentPage(description,bind.handle),{status:200,headers});
      }catch(error){logAuthorizationFailure(env,stage,error);return oauthError();}
    }
    if(request.method!=='POST')return oauthError(405);
    if(!checkBrowserPost(request)){logAuthorizationFailure(env,'consent_origin',null,'origin_rejected');return oauthError(403);}
    let form;
    try{form=await readForm(request);}catch{logAuthorizationFailure(env,'consent_form',null,'form_rejected');return oauthError();}
    if(!form){logAuthorizationFailure(env,'consent_form',null,'form_rejected');return oauthError();}
    const handle=form.get('handle'),decision=form.get('decision');
    if(typeof handle!=='string'||!/^[A-Za-z0-9_-]{24,256}$/.test(handle)||
       !['approve','deny'].includes(decision)){logAuthorizationFailure(env,'consent_form',null,'form_rejected');return oauthError();}
    let stage='consent_approval';
    try{
      if(decision==='deny'){
        if(form.has('scope'))return oauthError();
        const denied=await oauth.denyConsent(request,handle);
        return new Response(null,{status:302,headers:denied.headers});
      }
      // Fail without consuming the consent handle if the upstream provider
      // hasn't been explicitly configured in a later approved stage.
      stage='upstream_configuration';
      checkConfig(env);
      const selected=form.getAll('scope');
      if(!allowedSelection(selected,['mcp:read','offline_access'])){logAuthorizationFailure(env,'consent_selection',null,'scope_rejected');return oauthError();}
      // Consume without the provider's scope replacement: approveConsent({scope})
      // overwrites request.scope, which would erase whether offline_access was
      // offered and let a member add scopes the client never requested.
      stage='consent_approval';
      const approved=await oauth.approveConsent(request,handle);
      const offered=approved.request?.scope;
      if(!Array.isArray(offered)||!allowedSelection(selected,offered)){logAuthorizationFailure(env,'consent_selection',null,'scope_rejected');return oauthError();}
      const offlineOffered=offered.includes('offline_access');
      const verifier=pkceVerifier();
      stage='upstream_session';
      const upstream=await oauth.beginUpstream({...approved.request,scope:[...selected]},{
        data:{verifier,grantedScopes:selected,offlineOffered},headers:approved.headers
      });
      stage='upstream_redirect';
      const location=await startUrl({state:upstream.state,verifier,env});
      const headers=new Headers(upstream.headers);
      headers.set('location',location);
      headers.set('cache-control','no-store');
      headers.set('referrer-policy','no-referrer');
      return new Response(null,{status:302,headers});
    }catch(error){logAuthorizationFailure(env,stage,error);return oauthError();}
  }

  async function callback(request,env){
    const early=rejectEarlyData(request);if(early)return early;
    if(env?.OAUTH_SERVER_ENABLED!=='true'||env?.OAUTH_CONSENT_ENABLED!=='true')
      return unavailable();
    const url=new URL(request.url);
    if(request.method!=='GET'||url.origin!==ORIGIN||url.pathname!==CALLBACK_PATH)
      return oauthError(403);
    // Reject ambiguous responses before consuming the browser-bound transaction.
    // Extensions are allowed, but security-relevant OAuth fields are singletons.
    const params=url.searchParams;
    if(['state','code','error','error_description','error_uri','iss'].some(
      key=>params.getAll(key).length>1)||
      !/^[A-Za-z0-9_-]{24,256}$/.test(params.get('state')||'')||
      params.has('code')===params.has('error')||
      !(params.get('code')||params.get('error'))){
      logAuthorizationFailure(env,'upstream_state_failed',null,'request_rejected');
      return oauthError();
    }
    let cleanup,stage='upstream_state_failed';
    try{
      const oauth=getOAuth(env);
      // Official provider validates one-time upstream state + browser cookie.
      const finished=await oauth.finishUpstream(request);
      if(!finished?.request||!finished?.headers)return oauthError();
      cleanup=finished.headers;
      if(url.searchParams.has('error')){
        const destination=errorRedirect(finished.request,'access_denied');
        let target;
        try{target=new URL(destination);}catch{return oauthError(400,cleanup);}
        const local=['localhost','127.0.0.1','[::1]'].includes(target.hostname);
        if(target.protocol!=='https:'&&!(target.protocol==='http:'&&local))
          return oauthError(400,cleanup);
        const headers=new Headers(finished.headers);
        headers.set('location',destination);
        headers.set('cache-control','no-store');
        headers.set('referrer-policy','no-referrer');
        return new Response(null,{status:302,headers});
      }
      const code=url.searchParams.get('code');
      const data=finished.data;
      if(typeof code!=='string'||!data||typeof data.verifier!=='string'||
         typeof data.offlineOffered!=='boolean'||
         !allowedSelection(data.grantedScopes,finished.request.scope))
        return oauthError(400,cleanup);
      // Subject must be validated by Cloudflare Access and ACTIVE D1 membership.
      // No access or refresh tokens enter the Cloudflare OAuth grant.
      stage='upstream_identity_failed';
      const userId=await verifyIdentity({request,code,verifier:data.verifier,env});
      const props={userId};
      // See refresh-grant.mjs. Do not copy this flag onto a declined
      // offline_access selection; that selection must stay without a refresh token.
      if(data.offlineOffered===false)props.connectorRefresh=true;
      stage='authorization_completion_failed';
      const completed=await oauth.completeAuthorization({
        request:finished.request,userId,scope:data.grantedScopes,
        metadata:{},props
      });
      const headers=new Headers(finished.headers);
      headers.set('location',completed.redirectTo);
      headers.set('cache-control','no-store');
      headers.set('referrer-policy','no-referrer');
      logOAuthStage(env,'authorization_completed');
      return new Response(null,{status:302,headers});
    }catch(error){logOAuthStage(env,stage);logAuthorizationFailure(env,stage,error);return oauthError(401,cleanup);}
  }
  return {authorize,callback};
}
