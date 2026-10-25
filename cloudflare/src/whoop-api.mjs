// Cloudflare WHOOP data adapter. Development-only: staged Worker is disabled.
// The incoming caller must already pass verified Supabase Auth and active D1 membership.
// Tokens are encrypted with a separate Cloudflare key. No Supabase credentials copied.
import { openWithKeyring, sealWithKeyring, needsReseal, tokenKeyring } from "./token-crypto.mjs";
import { migrateConnection, migrateAllTokens } from "./token-migration.mjs";
import { activeMembership } from "./storage.mjs";
import { validWhoopToken } from "./history-pagination.mjs";
import { reserveWhoopRequest } from "./member-rate-limit.mjs";

const API="https://api.prod.whoop.com/developer/v2/";
const TOKEN_ENDPOINT="https://api.prod.whoop.com/oauth/oauth2/token";
const resources=Object.freeze({
  profile:{path:"user/profile/basic",history:false},
  measurements:{path:"user/measurement/body",history:false},
  recovery:{path:"recovery",history:true},
  sleep:{path:"activity/sleep",history:true},
  workouts:{path:"activity/workout",history:true},
  cycles:{path:"cycle",history:true}
});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timeout=()=>AbortSignal.timeout(12000);
function config(env) {
  if(!env)throw Error("Token key unavailable");
  return tokenKeyring(env);
}
async function openToken(envelope,id,purpose,keys){
  return (await openWithKeyring(envelope,{userId:id,purpose,keys})).token;
}
async function backgroundMigrate(db,id,row,keys,env,now){
  // Never blocks or fails a read. Counts only are logged by the batch pass.
  try{
    const opened=await openWithKeyring(row.encrypted_access_token,{userId:id,purpose:"access",keys});
    const refreshKey=row.encrypted_refresh_token?await openWithKeyring(row.encrypted_refresh_token,{userId:id,purpose:"refresh",keys}):null;
    if(needsReseal(row.encrypted_access_token,opened.key,keys)||
       (refreshKey&&needsReseal(row.encrypted_refresh_token,refreshKey.key,keys))){
      const outcome=await migrateConnection(db,id,row,keys,{now});
      console.log(JSON.stringify({event:"token_key_lazy",key:keys.current,outcome}));
    }
  }catch{console.log(JSON.stringify({event:"token_key_lazy",key:keys.current,outcome:"failed"}));}
  try{await migrateAllTokens(db,env,{now});}catch{/* counts are logged when it runs */}
}
function clientConfig(env){
  if(typeof env?.WHOOP_CLIENT_ID!=="string"||!env.WHOOP_CLIENT_ID||
     typeof env?.WHOOP_CLIENT_SECRET!=="string"||!env.WHOOP_CLIENT_SECRET)
    throw Error("WHOOP OAuth not configured");
  return env;
}
// WHOOP sends X-RateLimit-Reset (seconds); Retry-After may be seconds or an
// HTTP date. Bounded to one hour so a bad header cannot suggest a long wait.
export function retryAfterSeconds(headers,now=Date.now()){
  const read=name=>{try{return headers?.get?.(name)??null;}catch{return null;}};
  for(const name of ["retry-after","x-ratelimit-reset"]){
    const raw=read(name);
    if(typeof raw!=="string"||!raw.trim()||raw.length>64)continue;
    const value=raw.trim();
    let seconds=null;
    if(/^\d{1,6}$/.test(value))seconds=Number(value);
    else if(name==="retry-after"){const at=Date.parse(value);if(Number.isFinite(at))seconds=Math.ceil((at-now)/1000);}
    if(seconds!=null&&Number.isFinite(seconds))return Math.min(3600,Math.max(0,seconds));
  }
  return null;
}
function rateLimited(response,message){
  const error=Error(message);error.status=429;
  const after=retryAfterSeconds(response.headers);
  if(after!=null)error.retryAfter=after;
  return error;
}
function ownerId(value){if(typeof value!=="string"||!UUID.test(value))throw Error("Invalid user");return value.toLowerCase();}
async function boundedJson(response){
  const length=Number(response.headers.get("content-length"));
  if(Number.isFinite(length)&&length>2_000_000)throw Error("WHOOP response too large");
  const text=await response.text();
  if(text.length>2_000_000)throw Error("WHOOP response too large");
  return JSON.parse(text);
}
async function concurrentlyRefreshed(db,id,previous,key,now,sleep,attempts=4){
  // Bounded wait (about 1.5 s; lease followers use waitForHolder) for the winning
  // request to store its rotation.
  for(let attempt=0;attempt<attempts;attempt++){
    if(attempt)await sleep(500);
    const token=await storedRotation(db,id,previous,key,now);
    if(token)return token;
  }
  return null;
}
async function storedRotation(db,id,previous,key,now){
  const row=await db.prepare(
    "SELECT encrypted_access_token,encrypted_refresh_token,expires_at FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  if(!row||row.encrypted_refresh_token===previous.encrypted_refresh_token)return null;
  const expiry=Date.parse(row.expires_at);
  if(!Number.isFinite(expiry)||expiry<=now()+60_000)return null;
  return openToken(row.encrypted_access_token,id,"access",key);
}
// Per-member single flight plus a persistent reservation. Reservations expire
// before dispatch, but a dispatched refresh must never be taken over: WHOOP
// may already have consumed the stored token while its rotated pair is waiting
// for D1. A crashed dispatched holder requires reconnect rather than token reuse.
// No schema change; reconnect replaces the marker and credentials together.
const inflightRefresh=new Map();
const LEASE_SECONDS=120;
// Followers remain bounded even when the holder's persistence is stalled.
const HOLDER_DEADLINE_MS=15_000;
async function waitForHolder(db,id,row,key,now,sleep){
  for(let attempt=0;attempt<=HOLDER_DEADLINE_MS/500+1;attempt++){
    if(attempt)await sleep(500);
    const token=await storedRotation(db,id,row,key,now);
    if(token)return token;
    const current=await db.prepare("SELECT updated_at FROM whoop_connections WHERE user_id=?1 LIMIT 1").bind(id).first();
    const marker=typeof current?.updated_at==="string"&&/^(lease:|refreshing:)/.test(current.updated_at)?Date.parse(current.updated_at.replace(/^[^:]+:/,"")):NaN;
    // No live marker: the holder finished. One last read covers a rotation
    // stored between the two queries.
    if(!Number.isFinite(marker)||(current.updated_at.startsWith("lease:")&&now()-marker>=LEASE_SECONDS*1000))return storedRotation(db,id,row,key,now);
    if(now()>marker+HOLDER_DEADLINE_MS)return null;
  }
  return null;
}
const claimLeaseSql="UPDATE whoop_connections SET updated_at='lease:'||?3 "+
  "WHERE user_id=?1 AND encrypted_refresh_token=?2 AND substr(updated_at,1,11)<>'refreshing:' AND NOT ("+
  "substr(updated_at,1,6)='lease:' AND julianday(substr(updated_at,7)) IS NOT NULL AND "+
  "julianday(substr(updated_at,7))>julianday(?3)-"+LEASE_SECONDS+"/86400.0 AND "+
  "julianday(substr(updated_at,7))<=julianday(?3)+"+LEASE_SECONDS+"/86400.0)";
export function refreshRejected(status){
  const error=Error("WHOOP refresh rejected");error.status=status;error.refreshRejected=true;return error;
}
export async function whoopAccessToken(db, userId, env, deps={}){
  const id=ownerId(userId);
  const shared=inflightRefresh.get(id);
  if(shared)return sharedWithDeadline(db,id,env,shared,deps);
  const run=accessTokenOnce(db,id,env,deps);
  const entry={run,startedAt:(deps.now||Date.now)()};
  inflightRefresh.set(id,entry);
  // Only a refreshing call stays registered long; a valid-token read resolves
  // immediately. Remove the entry whichever way it settles.
  run.then(()=>{},()=>{}).finally(()=>{if(inflightRefresh.get(id)===entry)inflightRefresh.delete(id);});
  return run;
}
// Callers sharing this isolate's in-flight refresh are bounded like
// cross-isolate followers: at HOLDER_DEADLINE_MS after the holder started they
// use a stored rotation if one landed, else fail retryably. The holder keeps
// running and keeps its lease; no second refresh is started.
async function sharedWithDeadline(db,id,env,{run,startedAt},{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let settled=false;
  const done=run.finally(()=>{settled=true;});
  const deadline=(async()=>{
    // Wakes every 500 ms (no D1 reads) and stops as soon as the refresh settles.
    while(!settled&&now()<startedAt+HOLDER_DEADLINE_MS){
      await sleep(500);await new Promise(r=>setTimeout(r,0));
    }
    if(settled)return done;
    const row=await db.prepare("SELECT encrypted_access_token,expires_at FROM whoop_connections WHERE user_id=?1 LIMIT 1").bind(id).first();
    const expiry=Date.parse(row?.expires_at);
    if(row&&Number.isFinite(expiry)&&expiry>now()+60_000)return openToken(row.encrypted_access_token,id,"access",config(env));
    throw Error("WHOOP refresh failed");
  })();
  return Promise.race([done,deadline]);
}
async function accessTokenOnce(db, userId, env, {fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const id=ownerId(userId),key=config(env);
  if(!await activeMembership(db,id))throw Error("Membership required");
  const row=await db.prepare(
    "SELECT encrypted_access_token,encrypted_refresh_token,expires_at,scope,updated_at FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  if(!row)throw Error("WHOOP connection required");
  const currentExpiry=Date.parse(row.expires_at);
  if(Number.isFinite(currentExpiry)&&currentExpiry>now()+60_000){
    const token=await openToken(row.encrypted_access_token,id,"access",key);
    if(key.current==="k2")await backgroundMigrate(db,id,row,key,env,now);
    return token;
  }
  clientConfig(env);
  const refresh=await openToken(row.encrypted_refresh_token,id,"refresh",key);
  // Cross-isolate lease: if another request already claimed this refresh
  // token, wait for its stored rotation instead of reusing the token.
  const claimedAt=new Date(now()).toISOString();
  const tookOver=typeof row.updated_at==="string"&&row.updated_at.startsWith("lease:");
  const lease=await db.prepare(claimLeaseSql).bind(id,row.encrypted_refresh_token,claimedAt).run();
  if(!lease?.success||lease.meta?.changes!==1){
    const winner=await waitForHolder(db,id,row,key,now,sleep);
    if(winner)return winner;
    throw Error("WHOOP refresh raced or failed");
  }
  // Fence dispatch against an expired reservation's late holder. Once sent,
  // this marker blocks takeover even beyond the reservation timeout.
  const dispatchMarker='refreshing:'+claimedAt;
  const dispatch=await db.prepare("UPDATE whoop_connections SET updated_at=?3 WHERE user_id=?1 AND encrypted_refresh_token=?2 AND updated_at=?4")
    .bind(id,row.encrypted_refresh_token,dispatchMarker,'lease:'+claimedAt).run();
  if(!dispatch?.success||dispatch.meta?.changes!==1)throw Error("WHOOP refresh raced or failed");
  let receivedRotation=false;
  // Any outcome that did not store a rotation restores the previous
  // updated_at (only if our marker is still there), so a 429, outage or
  // rejected token leaves the row exactly as it was and never blocks the
  // next attempt for the lease period.
  const rotate=async()=>{
    const form=new URLSearchParams({
      grant_type:"refresh_token",refresh_token:refresh,
      client_id:env.WHOOP_CLIENT_ID,client_secret:env.WHOOP_CLIENT_SECRET,
      // WHOOP recommends requesting offline when refreshing as well as on the
      // initial grant (developer.whoop.com/docs/developing/support, refresh
      // tutorial payload). Read scopes are not re-sent: WHOOP's refresh payload
      // only documents offline, and the response scope is stored as returned.
      scope:"offline"
    });
    // Transport failures, the 12 s timeout and unreadable bodies are labelled
    // here, inside the shared refresh, so every caller sharing it (not only the
    // one whose fetch ran) reports a refresh failure.
    let response;
    try{
      response=await fetcher(TOKEN_ENDPOINT,{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body:form,redirect:"manual",cache:"no-store",credentials:"omit",signal:timeout()
      });
    }catch{throw Error("WHOOP refresh failed");}
    if(!response.ok){
      // WHOOP rotates refresh tokens: a parallel request that already used this
      // one makes ours fail. Use the access token that request stored, if any.
      // Taking over a stale lease means an earlier holder may have rotated
      // this token at WHOOP and still be writing it (a D1 write stalled past
      // the lease). Re-read the stored state for longer before classifying,
      // and never report that case as a rejected connection.
      const rejected=response.status===400||response.status===401;
      const winner=await concurrentlyRefreshed(db,id,row,key,now,sleep,rejected&&tookOver?10:4);
      if(winner)return winner;
      // Bounded: this recovery window is given once. The failure path records
      // the failed takeover instead of restoring the stale marker, so the next
      // attempt is not a takeover and classifies a 400/401 as rejected.
      if(rejected&&tookOver){const e=Error("WHOOP refresh failed");e.failedTakeover=true;throw e;}
      // A rate-limited refresh is reported as such (the stored tokens are kept).
      if(response.status===429)throw rateLimited(response,"WHOOP refresh failed");
      // 400/401 from the token endpoint: WHOOP refused the stored refresh token
      // (invalid_grant) or the client. Not a transient outage; tokens are kept.
      if(response.status===400||response.status===401)throw refreshRejected(response.status);
      throw Error("WHOOP refresh failed");
    }
    let tokens;
    try{tokens=await boundedJson(response);}catch{throw Error("WHOOP refresh failed");}
    if(typeof tokens?.access_token!=="string"||tokens.access_token.length<1||
       !Number.isFinite(Number(tokens.expires_in))||Number(tokens.expires_in)<60 ||
       Number(tokens.expires_in)>31_536_000 ||
       (tokens.refresh_token!=null&&typeof tokens.refresh_token!=="string"))
      throw Error("Invalid WHOOP refresh response");
    receivedRotation=true;
    const nextRefresh=tokens.refresh_token||refresh;
    const nextAccessEnvelope=await sealWithKeyring(tokens.access_token,{userId:id,purpose:"access",keys:key});
    const nextRefreshEnvelope=await sealWithKeyring(nextRefresh,{userId:id,purpose:"refresh",keys:key});
    const expiresAt=new Date(now()+Number(tokens.expires_in)*1000).toISOString();
    // Optimistic update: do not overwrite a connection already refreshed elsewhere.
    const scope=typeof tokens.scope==="string"?tokens.scope:(row.scope||"");
    const write=expected=>db.prepare(
      "UPDATE whoop_connections SET encrypted_access_token=?1,encrypted_refresh_token=?2,"+
      "expires_at=?3,scope=?4,encryption_key_version=?7,updated_at=CURRENT_TIMESTAMP "+
      "WHERE user_id=?5 AND encrypted_refresh_token=?6 AND updated_at=?8"
    ).bind(nextAccessEnvelope,nextRefreshEnvelope,expiresAt,scope,id,expected,
           key.current==="k2"?"k2":"v1",dispatchMarker).run();
    let result=await write(row.encrypted_refresh_token);
    if(!result.success||result.meta?.changes!==1){
      // The ciphertext may have changed only because the row was re-encrypted
      // (same refresh token, new key). Then our rotation is still the newest:
      // retry against the current ciphertext so the new refresh token is kept.
      const current=await db.prepare(
        "SELECT encrypted_refresh_token FROM whoop_connections WHERE user_id=?1 LIMIT 1"
      ).bind(id).first();
      if(current?.encrypted_refresh_token&&current.encrypted_refresh_token!==row.encrypted_refresh_token){
        let same=false;
        try{same=await openToken(current.encrypted_refresh_token,id,"refresh",key)===refresh;}catch{same=false;}
        if(same)result=await write(current.encrypted_refresh_token);
      }
    }
    if(!result.success||result.meta?.changes!==1){
      const winner=await concurrentlyRefreshed(db,id,row,key,now,sleep);
      if(winner)return winner;
      throw Error("WHOOP refresh raced or failed");
    }
    // RB-021: a successful refresh was otherwise invisible. Console only (Workers
    // Logs), no D1 write, and no member id, token, scope or expiry.
    try{console.log(JSON.stringify({event:"whoop_refresh",outcome:"ok",rotated:tokens.refresh_token!=null}));}catch{/* log only */}
    if(key.current==="k2"){try{await migrateAllTokens(db,env,{now});}catch{/* logged when it runs */}}
    return tokens.access_token;
  };
  try{return await rotate();}
  catch(error){
    // Preserve the dispatch marker if WHOOP returned a usable rotation but
    // encryption/persistence failed; retrying the old token could revoke it.
    if(!receivedRotation)try{await db.prepare("UPDATE whoop_connections SET updated_at=?3 WHERE user_id=?1 AND updated_at=?2")
      .bind(id,dispatchMarker,error?.failedTakeover?'takeover-failed:'+claimedAt:row.updated_at).run();}catch{/* retain the marker rather than risking duplicate dispatch */}
    throw error;
  }
}
export async function callWhoop(db,userId,resource,env,opts={},deps={}){
  const spec=Object.hasOwn(resources,resource)?resources[resource]:null;
  if(!spec)throw Error("Unsupported WHOOP resource");
  const limit=opts.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error("Invalid limit");
  const nextToken=opts.next_token;
  // WHOOP's own cursor (base64 padding allowed). Clients never send it: MCP and
  // the REST routes unseal a member-bound cursor first (history-pagination.mjs).
  if(nextToken!=null&&(!spec.history||!validWhoopToken(nextToken)))
    throw Error("Invalid WHOOP cursor");
  // A refresh whose token-endpoint call times out, fails in transit or returns
  // an unreadable body throws a raw TypeError/DOMException/SyntaxError. Label it
  // as a refresh failure for diagnostics and the member message. The refresh
  // itself is unchanged: no retry, stored tokens untouched, no cause text kept.
  let refreshAttempted=false;
  const baseFetch=deps.fetcher||fetch;
  const observed=(input,init)=>{if(String(input)===TOKEN_ENDPOINT)refreshAttempted=true;return baseFetch(input,init);};
  let token;
  try{token=await whoopAccessToken(db,userId,env,{...deps,fetcher:observed});}
  catch(cause){
    if(refreshAttempted&&cause instanceof Error&&(["TypeError","TimeoutError","AbortError","SyntaxError"].includes(cause.name)||cause.message==="WHOOP response too large"))
      throw Error("WHOOP refresh failed");
    throw cause;
  }
  const search=new URLSearchParams();
  if(spec.history){
    search.set("limit",String(limit));
    if(nextToken)search.set("nextToken",nextToken);
    // Optional WHOOP time window (ISO 8601). Only sent when a caller passes it,
    // so existing requests are unchanged.
    for(const key of ["start","end"]){
      const value=opts[key];
      if(value==null)continue;
      if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))
        throw Error("Invalid WHOOP time window");
      search.set(key,value);
    }
  }
  const url=API+spec.path+(search.size?"?"+search:"");
  // Per-member share of WHOOP's app-wide limit, after the member and the
  // connection are verified and immediately before the outbound request.
  // Over budget throws a 429 (MemberRateLimited) and nothing is sent to WHOOP.
  await reserveWhoopRequest(db,userId,env,{now:deps.now});
  let response;
  try{
    response=await (deps.fetcher||fetch)(url,{
      method:"GET",headers:{authorization:"Bearer "+token,"accept":"application/json"},
      redirect:"manual",cache:"no-store",credentials:"omit",signal:timeout()
    });
  }catch(cause){
    // Network failure or the 12 s timeout: no status from WHOOP at all.
    const error=Error("WHOOP API request failed");error.status=0;error.resource=resource;
    error.network=cause?.name==="TimeoutError"||cause?.name==="AbortError"?"timeout":"network";throw error;
  }
  if(!response.ok){
    // Same message as before; the status lets optional features (the stress
    // estimate) tell a WHOOP rate limit (429) apart from other failures.
    // resource lets diagnostics say which WHOOP endpoint failed.
    if(response.status===429){const e=rateLimited(response,"WHOOP API request failed");e.resource=resource;throw e;}
    const error=Error("WHOOP API request failed");error.status=response.status;error.resource=resource;throw error;
  }
  const data=await boundedJson(response);
  if(!data||typeof data!=="object"||Array.isArray(data))throw Error("WHOOP response invalid");
  return data;
}
