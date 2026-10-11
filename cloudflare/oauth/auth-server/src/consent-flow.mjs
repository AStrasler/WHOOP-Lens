import {consentPage,noStoreHeaders,unavailable} from '../../consent.mjs';
import {verifyInvitedSignIn} from './login.mjs';
import {reserveLoginAttempt} from './rate-limit.mjs';
const approvedScopes=new Set(['mcp:read','offline_access']);
const oauthError=(message,status=400)=>new Response(message,{status,headers:noStoreHeaders()});
const readForm=async request=>{
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/x-www-form-urlencoded'))
    return null;
  const declared=Number(request.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>4096)return null;
  const text=await request.text();
  if(text.length>4096)return null;
  const body=new URLSearchParams(text);
  if([...body.keys()].some(x=>!['handle','decision','email','password','scope'].includes(x)))return null;
  if(['handle','decision','email','password'].some(k=>body.getAll(k).length>1))return null;
  return body;
};
export function makeConsentFlow({getOAuth,signIn=verifyInvitedSignIn,rateLimit=reserveLoginAttempt}={}){
  if(typeof getOAuth!=='function')throw Error('OAuth provider required');
  return async function authorize(request,env){
    if(env?.OAUTH_SERVER_ENABLED!=='true'||env?.OAUTH_CONSENT_ENABLED!=='true')return unavailable();
    const oauth=getOAuth(env);
    if(request.method==='GET'){
      try{
        const auth=await oauth.parseAuthRequest(request);
        const description=await oauth.describeConsent(auth);
        if(!auth.scope.includes('mcp:read')||auth.scope.some(x=>!approvedScopes.has(x)))
          return oauthError('Requested permissions unavailable');
        const binding=await oauth.beginConsent(auth);
        const headers=new Headers(binding.headers);
        for(const [key,value] of Object.entries(noStoreHeaders('text/html; charset=utf-8')))headers.set(key,value);
        return new Response(consentPage(description,binding.handle),{status:200,headers});
      }catch{return oauthError('Invalid authorization request');}
    }
    if(request.method!=='POST')return oauthError('Unsupported authorization method',405);
    let form;
    try{form=await readForm(request);}catch{return oauthError('Invalid authorization form');}
    if(!form)return oauthError('Invalid authorization form');
    const handle=form.get('handle');
    if(typeof handle!=='string'||handle.length<24||handle.length>256||!/^[A-Za-z0-9_-]+$/.test(handle))
      return oauthError('Invalid authorization request');
    const decision=form.get('decision');
    if(decision!=='approve'&&decision!=='deny')return oauthError('Invalid authorization decision');
    try{
      if(decision==='deny'){
        const rejected=await oauth.denyConsent(request,handle);
        return new Response(null,{status:302,headers:rejected.headers});
      }
      const selected=form.getAll('scope');
      if(selected.length<1||selected.length>2||new Set(selected).size!==selected.length||
         !selected.includes('mcp:read')||selected.some(x=>!approvedScopes.has(x)))
        return oauthError('Invalid authorization permissions');
      const approved=await oauth.approveConsent(request,handle,{scope:selected});
      if(!Array.isArray(approved.request?.scope)||!selected.every(x=>approved.request.scope.includes(x)))
        return oauthError('Invalid authorization permissions');
      const email=form.get('email'),password=form.get('password');
      if(typeof email!=='string'||typeof password!=='string'||
         email.length>320||password.length>1024||password.length<1)
        return oauthError('Sign-in or invitation check failed',401);
      const allowed=await rateLimit(request,email,env);
      if(!allowed)return oauthError('Too many sign-in attempts. Try again later.',429);
      const userId=await signIn({email,password,env});
      const result=await oauth.completeAuthorization({
        request:approved.request,userId,scope:selected,
        metadata:{},props:{userId}
      });
      const headers=new Headers(approved.headers);
      headers.set('location',result.redirectTo);
      headers.set('cache-control','no-store');
      headers.set('referrer-policy','no-referrer');
      return new Response(null,{status:302,headers});
    }catch{return oauthError('Sign-in or invitation check failed. Start authorization again.',401);}
  };
}
