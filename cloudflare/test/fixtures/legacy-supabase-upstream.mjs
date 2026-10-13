// WHOOP Lens OAuth upstream adapter (staging only).
// Supabase performs sign-in and consent on the EXISTING authorization UI.
// Cloudflare does not collect, process or store the user's password.
import { activeMembership } from '../../src/storage.mjs';

const AUTH_ORIGIN='https://evoiwauqplbcecumiwqn.supabase.co';
export const CALLBACK_URI='https://auth.whooplens.tech/oauth/upstream/callback';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID=/^[A-Za-z0-9._~-]{1,256}$/;
const SAFE_CODE=/^[A-Za-z0-9._~+/=-]{4,4096}$/;
const SAFE_VERIFIER=/^[A-Za-z0-9_-]{43,128}$/;
const timeout=()=>AbortSignal.timeout(8000);
export class UpstreamSignInDenied extends Error {
  constructor(){super('Upstream identity verification unavailable');}
}
export function checkUpstreamConfig(env){
  if(typeof env?.SUPABASE_UPSTREAM_CLIENT_ID!=='string' ||
     !CLIENT_ID.test(env.SUPABASE_UPSTREAM_CLIENT_ID) ||
     typeof env?.SUPABASE_PUBLIC_KEY!=='string'||!env.SUPABASE_PUBLIC_KEY ||
     !env.DB ||
     (env.SUPABASE_UPSTREAM_CLIENT_SECRET!=null &&
      (typeof env.SUPABASE_UPSTREAM_CLIENT_SECRET!=='string' ||
       env.SUPABASE_UPSTREAM_CLIENT_SECRET.length>4096)))
    throw new UpstreamSignInDenied();
  return env.SUPABASE_UPSTREAM_CLIENT_ID;
}
function base64url(bytes){
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function createVerifier(){
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function createChallenge(verifier){
  if(typeof verifier!=='string'||!SAFE_VERIFIER.test(verifier))throw new UpstreamSignInDenied();
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}
export async function upstreamAuthorizationUrl({state,verifier,env}){
  const clientId=checkUpstreamConfig(env);
  if(typeof state!=='string'||!/^[A-Za-z0-9_-]{24,256}$/.test(state))
    throw new UpstreamSignInDenied();
  const u=new URL(AUTH_ORIGIN+'/auth/v1/oauth/authorize');
  u.search=new URLSearchParams({
    client_id:clientId,redirect_uri:CALLBACK_URI,response_type:'code',
    scope:'openid',state,code_challenge:await createChallenge(verifier),
    code_challenge_method:'S256'
  }).toString();
  return u.toString();
}
async function boundedJson(response){
  if(Number(response.headers.get('content-length'))>16000)throw new UpstreamSignInDenied();
  const body=await response.text();
  if(body.length>16000)throw new UpstreamSignInDenied();
  const value=JSON.parse(body);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new UpstreamSignInDenied();
  return value;
}
export async function verifyUpstreamCode({code,verifier,env,fetcher=fetch}){
  checkUpstreamConfig(env);
  if(typeof code!=='string'||!SAFE_CODE.test(code)||
     typeof verifier!=='string'||!SAFE_VERIFIER.test(verifier))
    throw new UpstreamSignInDenied();
  let temporaryToken=null, verifiedUser=null, revoked=false;
  try{
    const form=new URLSearchParams({
      grant_type:'authorization_code',client_id:env.SUPABASE_UPSTREAM_CLIENT_ID,
      redirect_uri:CALLBACK_URI,code,code_verifier:verifier
    });
    if(env.SUPABASE_UPSTREAM_CLIENT_SECRET)form.set('client_secret',env.SUPABASE_UPSTREAM_CLIENT_SECRET);
    const result=await fetcher(AUTH_ORIGIN+'/auth/v1/oauth/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:form,redirect:'manual',credentials:'omit',cache:'no-store',
      referrerPolicy:'no-referrer',signal:timeout()
    });
    if(!result.ok)throw new UpstreamSignInDenied();
    const payload=await boundedJson(result);
    if(typeof payload.access_token!=='string'||payload.access_token.length<16||
       payload.access_token.length>8192||!/^[A-Za-z0-9._~-]+$/.test(payload.access_token))
      throw new UpstreamSignInDenied();
    temporaryToken=payload.access_token;
    const who=await fetcher(AUTH_ORIGIN+'/auth/v1/user',{
      method:'GET',headers:{apikey:env.SUPABASE_PUBLIC_KEY,
        authorization:'Bearer '+temporaryToken},
      redirect:'manual',cache:'no-store',credentials:'omit',
      referrerPolicy:'no-referrer',signal:timeout()
    });
    if(!who.ok)throw new UpstreamSignInDenied();
    const user=await boundedJson(who);
    if(typeof user.id!=='string'||!UUID.test(user.id))throw new UpstreamSignInDenied();
    const userId=user.id.toLowerCase();
    if(!await activeMembership(env.DB,userId))throw new UpstreamSignInDenied();
    verifiedUser=userId;
  }catch{throw new UpstreamSignInDenied();}
  finally{
    if(temporaryToken!==null){
      try{
        const response=await fetcher(AUTH_ORIGIN+'/auth/v1/logout?scope=local',{
          method:'POST',headers:{apikey:env.SUPABASE_PUBLIC_KEY,
            authorization:'Bearer '+temporaryToken},
          redirect:'manual',cache:'no-store',credentials:'omit',
          referrerPolicy:'no-referrer',signal:timeout()
        });
        revoked=response.ok;
      }catch{revoked=false;}
    }
    temporaryToken=null;
  }
  // An upstream grant can remain authorized, and Supabase access JWTs may remain
  // valid until expiry even after logout. No upstream token is stored downstream.
  if(!verifiedUser||!revoked)throw new UpstreamSignInDenied();
  return verifiedUser;
}
