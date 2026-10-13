// WHOOP OAuth handshake for the future Cloudflare backend.
// Not active in production. Requires WHOOP_OAUTH_ENABLED=true, which is disabled in Wrangler.
// Source Supabase WHOOP OAuth redirect remains unchanged until separate cutover approval.
import { activeMembership } from "./storage.mjs";
import { sealWithKeyring, tokenKeyring } from "./token-crypto.mjs";
const AUTH="https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN="https://api.prod.whoop.com/oauth/oauth2/token";
const REDIRECT="https://whooplens.tech/api/whoop/callback";
const SCOPES="offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALNUM=/^[A-Za-z0-9_-]{32,512}$/;
const NOW=()=>Date.now();
const decoder=new TextDecoder();
function requireConfig(env) {
  if(!env?.WHOOP_CLIENT_ID||!env?.WHOOP_CLIENT_SECRET||(!env?.WHOOP_TOKEN_AES256_KEY&&!env?.WHOOP_TOKEN_AES256_KEY_NEXT))
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
  // Bounded per member: drop expired states, and keep at most five pending
  // (the newest), so repeated connect calls cannot grow the table without limit.
  const [,saved]=await db.batch([
    db.prepare("DELETE FROM whoop_oauth_states WHERE user_id=?1 AND expires_at<=?2")
      .bind(id,new Date(now()).toISOString()),
    db.prepare("INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?1,?2,?3)")
      .bind(hash,id,expires_at),
    db.prepare("DELETE FROM whoop_oauth_states WHERE user_id=?1 AND state_hash NOT IN "+
      "(SELECT state_hash FROM whoop_oauth_states WHERE user_id=?1 ORDER BY expires_at DESC, rowid DESC LIMIT 5)")
      .bind(id)
  ]);
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
    "DELETE FROM whoop_oauth_states WHERE state_hash=?1 AND expires_at>?2 RETURNING user_id,created_at"
  ).bind(await sha256(state),new Date(now()).toISOString()).first();
  if(!row?.user_id||typeof row.created_at!=="string")throw Error("Invalid or expired WHOOP state");
  const id=validateUser(row.user_id);
  if(!await activeMembership(db,id))throw Error("Membership required");
  const stateCreated=comparableStamp(row.created_at);
  const existing=await db.prepare("SELECT seat_role FROM whoop_connections WHERE user_id=?1").bind(id).first();
  const role=existing?.seat_role||(id===env.WHOOP_LENS_DEVELOPER_USER_ID?"developer":"public");
  const response=await fetcher(TOKEN,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"authorization_code",code,client_id:env.WHOOP_CLIENT_ID,
      client_secret:env.WHOOP_CLIENT_SECRET,redirect_uri:REDIRECT
    }),
    redirect:"manual",cache:"no-store",credentials:"omit",signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw Error("WHOOP token exchange failed");
  const data=await safeJson(response);
  if(typeof data?.access_token!=="string"||!data.access_token||
     typeof data?.refresh_token!=="string"||!data.refresh_token||
     !Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<60||
     Number(data.expires_in)>31_536_000)
    throw Error("Invalid WHOOP token response");
  const keys=tokenKeyring(env);
  const access=await sealWithKeyring(data.access_token,{userId:id,purpose:"access",keys});
  const refresh=await sealWithKeyring(data.refresh_token,{userId:id,purpose:"refresh",keys});
  const expiresAt=new Date(now()+Number(data.expires_in)*1000).toISOString();
  // Seat limit and one-developer-seat constraints are enforced by SQLite
  // migration 0002, including concurrent callbacks.
  const saved=await db.prepare(
    "INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,"+
    "encrypted_refresh_token,encryption_key_version,seat_role) "+
    "SELECT ?1,?2,?3,?4,?5,?8,?6 WHERE NOT EXISTS ("+
    "SELECT 1 FROM whoop_credential_revocations WHERE user_id=?1 AND revoked_at>=?7) "+
    "ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,scope=excluded.scope,"+
    "encrypted_access_token=excluded.encrypted_access_token,"+
    "encrypted_refresh_token=excluded.encrypted_refresh_token,encryption_key_version=excluded.encryption_key_version,updated_at=CURRENT_TIMESTAMP "+
    "WHERE NOT EXISTS (SELECT 1 FROM whoop_credential_revocations WHERE user_id=?1 AND revoked_at>=?7)"
  ).bind(id,expiresAt,typeof data.scope==="string"?data.scope:"",access,refresh,role,stateCreated,keys.current==="k2"?"k2":"v1").run();
  if(!saved?.success||saved.meta?.changes!==1){
    const blocked=await db.prepare(
      "SELECT user_id FROM whoop_credential_revocations WHERE user_id=?1 AND revoked_at>=?2"
    ).bind(id,stateCreated).first();
    if(blocked)throw Error("WHOOP authorization was revoked");
    throw Error("WHOOP connection save failed");
  }
  return {connected:true,seat_role:role};
}
function utcStamp(ms){
  return new Date(ms).toISOString().slice(0,19).replace("T"," ");
}
function comparableStamp(value){
  if(typeof value!=="string"||value.length<19)throw Error("Invalid or expired WHOOP state");
  const iso=value.includes("T")?value:value.slice(0,19).replace(" ","T")+"Z";
  const parsed=Date.parse(iso);
  if(!Number.isFinite(parsed))throw Error("Invalid or expired WHOOP state");
  return utcStamp(parsed);
}
export async function revokeWhoopConnection(db,userId,{now=NOW}={}){
  const id=validateUser(userId);
  if(!await activeMembership(db,id))throw Error("Membership required");
  if(typeof db.batch!=="function")throw Error("WHOOP disconnect failed");
  // Atomic with the credential deletion. A callback that already consumed its
  // state still cannot save tokens created at or before this revocation.
  let results;
  try{
    results=await db.batch([
      db.prepare(
        "INSERT INTO whoop_credential_revocations(user_id,revoked_at) VALUES(?1,?2) "+
        "ON CONFLICT(user_id) DO UPDATE SET revoked_at=excluded.revoked_at"
      ).bind(id,utcStamp(now())),
      db.prepare("DELETE FROM whoop_oauth_states WHERE user_id=?1").bind(id),
      db.prepare("DELETE FROM whoop_connections WHERE user_id=?1").bind(id)
    ]);
  }catch{throw Error("WHOOP disconnect failed");}
  if(!Array.isArray(results)||results.length!==3||results.some(result=>result?.success===false))
    throw Error("WHOOP disconnect failed");
  return {disconnected:true,removed:results[2].meta?.changes===1};
}
