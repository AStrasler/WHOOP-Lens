// Atomic D1 counters keyed by HMAC, never raw email or IP addresses.
const encoder=new TextEncoder();
function fromBase64Url(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Bad key');
  const raw=atob(value.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(value.length/4)*4,'='));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function digest(key,input){
  const k=await crypto.subtle.importKey('raw',fromBase64Url(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const hash=new Uint8Array(await crypto.subtle.sign('HMAC',k,encoder.encode(input)));
  return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function reserveLoginAttempt(request,email,env,{now=Date.now}={}){
  const secret=env?.AUTH_RATE_HMAC_KEY;
  const ip=request.headers.get('cf-connecting-ip');
  if(!ip||ip.length>64||!/^[0-9a-fA-F:.]+$/.test(ip)||
     !env?.DB||typeof secret!=='string'||fromBase64Url(secret).length!==32)
    return false;
  const bucket=Math.floor(now()/900000)*900000;
  const keys=[await digest(secret,'ip:'+ip),await digest(secret,'email:'+email.toLowerCase().trim())];
  for(const key of keys){
    const result=await env.DB.prepare(
      'INSERT INTO oauth_login_attempts(bucket_hash,window_start,hits) VALUES(?,?,1) '+
      'ON CONFLICT(bucket_hash,window_start) DO UPDATE SET hits=hits+1 '+
      'WHERE hits<5 RETURNING hits'
    ).bind(key,bucket).first();
    if(!result||!Number.isSafeInteger(result.hits)||result.hits<1||result.hits>5)return false;
  }
  return true;
}
