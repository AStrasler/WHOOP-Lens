// WHOOP OAuth handshake for the future Cloudflare backend.
// Not active in production. Requires WHOOP_OAUTH_ENABLED=true, which is disabled in Wrangler.
// Source Supabase WHOOP OAuth redirect remains unchanged until separate cutover approval.
import { activeMembership } from "./storage.mjs";
import { sealWhoopToken } from "./token-crypto.mjs";
const AUTH="https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN="https://api.prod.whoop.com/oauth/oauth2/token";
const REDIRECT="https://whooplens.tech/api/whoop/callback";
const SCOPES="offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALNUM=/^[A-Za-z0-9_-]{32,512}$/;
const NOW=()=>Date.now();
const decoder=new TextDecoder();
function requireConfig(env) {
  if(!env?.WHOOP_CLIENT_ID||!env?.WHOOP_CLIENT_SECRET||!env?.WHOOP_TOKEN_AES256_KEY)
    throw Error("WHOOP OAuth credentials not configured");
  if(env.WHOOP_REDIRECT_URI!==REDIRECT)
    throw Error("WHOOP redirect not configured for approved domain");
  return env;
}
function validateUser(userId) {
  if(typeof userId!=="string"||!UUID.test(userId))throw Error("Invalid user");
  return userId.toLowerCase();
}
function tokenString(size=32) {
  const bytes=crypto.getRandomValues(new Uint8Array(size));
  // base64url; the authorize response never exposes the digest-only stored state.
  return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
async function sha256(value){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function safeJson(response){
  const raw=await response.text();
  if(raw.length>16384)throw Error("WHOOP token response too large");
  return JSON.parse(raw);
}
export async function createWhoopAuthorization(db,userId,env,{now=NOW}={}){
  requireConfig(env);
  const id=validateUser(userId);
  if(!await activeMembership(db,id))throw Error("Membership required");
  const state=tokenString(),expires_at=new Date(now()+10*60_000).toISOString();
  const hash=await sha256(state);
  const saved=await db.prepare(
    "INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?1,?2,?3)"
  ).bind(hash,id,expires_at).run();
  if(!saved?.success||saved.meta?.changes!==1)throw Error("WHOOP authorization state unavailable");
  const params=new URLSearchParams({
    client_id:env.WHOOP_CLIENT_ID,redirect_uri:REDIRECT,response_type:"code",
    scope:SCOPES,state
  });
  return {authorization_url:AUTH+"?"+params};
}
export async function acceptWhoopCallback(db,callback,env,{fetcher=fetch,now=NOW}={}){
  requireConfig(env);
  const url=callback instanceof URL?callback:new URL(callback);
  if(url.origin!=="https://whooplens.tech"||url.pathname!=="/api/whoop/callback")
    throw Error("Unexpected callback origin");
  if(url.searchParams.has("error"))throw Error("WHOOP authorization declined");
  const state=url.searchParams.get("state"),code=url.searchParams.get("code");
  if(typeof state!=="string"||!ALNUM.test(state)||
     typeof code!=="string"||code.length<4||code.length>4096||
     !/^[A-Za-z0-9._~+/-]+$/.test(code))
    throw Error("Invalid WHOOP callback");
  // Atomically consume this state, even on error. Replay is impossible.
  const row=await db.prepare(
    "DELETE FROM whoop_oauth_states WHERE state_hash=?1 AND expires_at>?2 RETURNING user_id"
  ).bind(await sha256(state),new Date(now()).toISOString()).first();
  if(!row?.user_id)throw Error("Invalid or expired WHOOP state");
  const id=validateUser(row.user_id);
  if(!await activeMembership(db,id))throw Error("Membership required");
  const existing=await db.prepare("SELECT seat_role FROM whoop_connections WHERE user_id=?1").bind(id).first();
  const role=existing?.seat_role||(id===env.WHOOP_LENS_DEVELOPER_USER_ID?"developer":"public");
  const response=await fetcher(TOKEN,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"authorization_code",code,client_id:env.WHOOP_CLIENT_ID,
      client_secret:env.WHOOP_CLIENT_SECRET,redirect_uri:REDIRECT
    }),
    redirect:"error",cache:"no-store",credentials:"omit",signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw Error("WHOOP token exchange failed");
  const data=await safeJson(response);
  if(typeof data?.access_token!=="string"||!data.access_token||
     typeof data?.refresh_token!=="string"||!data.refresh_token||
     !Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<60||
     Number(data.expires_in)>31_536_000)
    throw Error("Invalid WHOOP token response");
  const key=env.WHOOP_TOKEN_AES256_KEY;
  const access=await sealWhoopToken(data.access_token,{userId:id,purpose:"access",key});
  const refresh=await sealWhoopToken(data.refresh_token,{userId:id,purpose:"refresh",key});
  const expiresAt=new Date(now()+Number(data.expires_in)*1000).toISOString();
  // Seat limit and one-developer-seat constraints are enforced by SQLite
  // migration 0002, including concurrent callbacks.
  const saved=await db.prepare(
    "INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,"+
    "encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?1,?2,?3,?4,?5,'v1',?6) "+
    "ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,scope=excluded.scope,"+
    "encrypted_access_token=excluded.encrypted_access_token,"+
    "encrypted_refresh_token=excluded.encrypted_refresh_token,updated_at=CURRENT_TIMESTAMP"
  ).bind(id,expiresAt,typeof data.scope==="string"?data.scope:"",access,refresh,role).run();
  if(!saved?.success||saved.meta?.changes!==1)throw Error("WHOOP connection save failed");
  return {connected:true,seat_role:role};
}
