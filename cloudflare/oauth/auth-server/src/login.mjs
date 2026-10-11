// Transitional identity: Supabase remains WHOOP Lens's source of truth.
// Credentials are sent only to Supabase Auth. This temporary session is
// revoked before Cloudflare OAuth issues a separate grant. Never log credentials.
import { activeMembership } from '../../../src/storage.mjs';
const AUTH_ORIGIN='https://evoiwauqplbcecumiwqn.supabase.co';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]{1,128}@[^\s@]{1,255}$/;
const timeout=()=>AbortSignal.timeout(8000);
export class SignInDenied extends Error { constructor(){super('Sign-in not accepted');} }

export async function verifyInvitedSignIn({email,password,env,fetcher=fetch}) {
  if(typeof email!=='string'||!EMAIL.test(email)||email.length>320||
     typeof password!=='string'||password.length<1||password.length>1024||
     typeof env?.SUPABASE_PUBLIC_KEY!=='string'||!env.SUPABASE_PUBLIC_KEY||!env.DB)
    throw new SignInDenied();

  let temporaryToken=null, verifiedUserId=null, revoked=false;
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
    if(typeof token!=='string'||token.length<16||token.length>8192||
       !/^[A-Za-z0-9._~-]+$/.test(token))throw new SignInDenied();
    temporaryToken=token;
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
       session?.user?.id?.toLowerCase()!==user.id.toLowerCase())
      throw new SignInDenied();
    const userId=user.id.toLowerCase();
    if(!await activeMembership(env.DB,userId))throw new SignInDenied();
    verifiedUserId=userId;
  }catch {
    // No responses or logs ever reveal account existence or sign-in state.
    throw new SignInDenied();
  }finally {
    // Supabase's local logout revokes the newly minted refresh session.
    // An access JWT may remain valid until expiry; it is NEVER persisted or
    // exposed. Fail closed if logout fails instead of issuing an OAuth grant.
    if(temporaryToken!==null) {
      try {
        const logout=await fetcher(AUTH_ORIGIN+'/auth/v1/logout?scope=local',{
          method:'POST',
          headers:{apikey:env.SUPABASE_PUBLIC_KEY,authorization:'Bearer '+temporaryToken},
          redirect:'error',cache:'no-store',credentials:'omit',
          referrerPolicy:'no-referrer',signal:timeout()
        });
        revoked=logout.ok;
      }catch { revoked=false; }
    }
    temporaryToken=null;
  }
  if(!verifiedUserId||!revoked)throw new SignInDenied();
  return verifiedUserId;
}
