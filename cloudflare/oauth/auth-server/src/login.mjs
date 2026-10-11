// Transitional identity: Supabase remains WHOOP Lens's source of truth.
// Credentials are forwarded only to its Auth endpoint; never persisted in D1,
// OAuth props, cookies or logs. This is not a replacement for Supabase Auth.
import { activeMembership } from '../../../src/storage.mjs';
const AUTH_ORIGIN='https://evoiwauqplbcecumiwqn.supabase.co';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]{1,128}@[^\s@]{1,255}$/;
const timeout=()=>AbortSignal.timeout(8000);
export class SignInDenied extends Error { constructor(){super('Sign-in not accepted');} }
export async function verifyInvitedSignIn({email,password,env,fetcher=fetch}) {
  if(typeof email!=='string'||!EMAIL.test(email)||email.length>320||
     typeof password!=='string'||password.length<1||password.length>1024 ||
     typeof env?.SUPABASE_PUBLIC_KEY!=='string'||!env.SUPABASE_PUBLIC_KEY || !env.DB)
    throw new SignInDenied();
  try {
    const response=await fetcher(AUTH_ORIGIN+'/auth/v1/token?grant_type=password',{
      method:'POST',headers:{apikey:env.SUPABASE_PUBLIC_KEY,'content-type':'application/json'},
      body:JSON.stringify({email,password}),
      redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:timeout()
    });
    if(!response.ok)throw new SignInDenied();
    if(Number(response.headers.get('content-length'))>16000)throw new SignInDenied();
    const raw=await response.text();
    if(raw.length>16000)throw new SignInDenied();
    const session=JSON.parse(raw), token=session?.access_token;
    if(typeof token!=='string'||token.length<16||token.length>8192 ||
       !/^[A-Za-z0-9._~-]+$/.test(token))throw new SignInDenied();
    const check=await fetcher(AUTH_ORIGIN+'/auth/v1/user',{
      method:'GET',headers:{apikey:env.SUPABASE_PUBLIC_KEY,authorization:'Bearer '+token},
      redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:timeout()
    });
    if(!check.ok)throw new SignInDenied();
    if(Number(check.headers.get('content-length'))>16000)throw new SignInDenied();
    const userText=await check.text();
    if(userText.length>16000)throw new SignInDenied();
    const user=JSON.parse(userText);
    if(typeof user?.id!=='string'||!UUID.test(user.id)||
       session?.user?.id?.toLowerCase()!==user.id.toLowerCase())throw new SignInDenied();
    const userId=user.id.toLowerCase();
    if(!await activeMembership(env.DB,userId))throw new SignInDenied();
    return userId;
  }catch{throw new SignInDenied();}
}
