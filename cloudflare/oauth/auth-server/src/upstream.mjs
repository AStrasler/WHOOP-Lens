// Independent browser identity: only Cloudflare Access and local D1 membership.
// The callback is protected by Access; the literal code is a flow marker, NOT
// a credential. A signed application JWT and browser-bound OAuth state are required.
import {activeMembership} from '../../../src/storage.mjs';
export const CALLBACK_URI='https://auth.whooplens.tech/oauth/upstream/callback';
export class UpstreamSignInDenied extends Error {
  constructor(){super('Identity verification unavailable');}
}
export function checkUpstreamConfig(env){
  if(!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env?.ACCESS_ISSUER||'')||
     !/^[a-f0-9]{64}$/.test(env?.ACCESS_AUD||'')||!env?.DB)throw new UpstreamSignInDenied();
  return env.ACCESS_ISSUER;
}
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export function createVerifier(){return b64(crypto.getRandomValues(new Uint8Array(32)));}
export async function createChallenge(value){return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));}
export async function upstreamAuthorizationUrl({state,env}){
  checkUpstreamConfig(env);
  if(!/^[A-Za-z0-9_-]{24,256}$/.test(state||''))throw new UpstreamSignInDenied();
  return CALLBACK_URI+'?'+new URLSearchParams({state,code:'access'});
}
function decode(segment){
  if(!/^[A-Za-z0-9_-]+$/.test(segment))throw new UpstreamSignInDenied();
  return Uint8Array.from(atob(segment.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
}
function parse(segment){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(segment)));}
export async function verifyUpstreamCode({request,code,env,fetcher=fetch,now=Date.now()}){
  try{
    const issuer=checkUpstreamConfig(env);
    if(code!=='access'||!request||new URL(request.url).origin!=='https://auth.whooplens.tech' ||
       new URL(request.url).pathname!=='/oauth/upstream/callback')throw new UpstreamSignInDenied();
    const jwt=request.headers.get('cf-access-jwt-assertion');
    if(typeof jwt!=='string'||jwt.length>16384)throw new UpstreamSignInDenied();
    const parts=jwt.split('.');
    if(parts.length!==3)throw new UpstreamSignInDenied();
    const header=parse(parts[0]),claims=parse(parts[1]),seconds=Math.floor(now/1000);
    if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256||header.crit||
       claims.iss!==issuer||!Array.isArray(claims.aud)||!claims.aud.includes(env.ACCESS_AUD)||
       claims.type!=='app'||typeof claims.sub!=='string'||claims.sub.length<1||claims.sub.length>256||
       typeof claims.email!=='string'||claims.email.length>254||!claims.email.includes('@')||
       !Number.isSafeInteger(claims.exp)||claims.exp<=seconds||
       !Number.isSafeInteger(claims.iat)||claims.iat>seconds+30||claims.exp<=claims.iat||
       (claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>seconds+30)))
      throw new UpstreamSignInDenied();
    // Never follow jku/x5u or a URL from the JWT. Only the configured team's certs.
    const response=await fetcher(issuer+'/cdn-cgi/access/certs',{
      redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(8000)});
    if(!response.ok||Number(response.headers.get('content-length'))>65536)throw new UpstreamSignInDenied();
    const body=await response.text();
    if(body.length>65536)throw new UpstreamSignInDenied();
    const keys=JSON.parse(body).keys;
    if(!Array.isArray(keys)||keys.length>20)throw new UpstreamSignInDenied();
    const matches=keys.filter(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
    if(matches.length!==1)throw new UpstreamSignInDenied();
    const key=await crypto.subtle.importKey('jwk',matches[0],{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))
      throw new UpstreamSignInDenied();
    // Explicit subject mapping only. Never auto-enrol or link accounts by email.
    const row=await env.DB.prepare('SELECT user_id FROM access_identity_links WHERE issuer=?1 AND subject=?2 AND enabled=1')
      .bind(issuer,claims.sub).first();
    if(!row||!await activeMembership(env.DB,row.user_id))throw new UpstreamSignInDenied();
    return row.user_id;
  }catch{throw new UpstreamSignInDenied();}
}
