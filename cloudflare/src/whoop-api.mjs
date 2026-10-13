// Cloudflare WHOOP data adapter. Development-only: staged Worker is disabled.
// The incoming caller must already pass verified Supabase Auth and active D1 membership.
// Tokens are encrypted with a separate Cloudflare key. No Supabase credentials copied.
import { openWhoopToken, sealWhoopToken } from "./token-crypto.mjs";
import { activeMembership } from "./storage.mjs";

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
  if(!env||typeof env.WHOOP_TOKEN_AES256_KEY!=="string")throw Error("Token key unavailable");
  return env.WHOOP_TOKEN_AES256_KEY;
}
function clientConfig(env){
  if(typeof env?.WHOOP_CLIENT_ID!=="string"||!env.WHOOP_CLIENT_ID||
     typeof env?.WHOOP_CLIENT_SECRET!=="string"||!env.WHOOP_CLIENT_SECRET)
    throw Error("WHOOP OAuth not configured");
  return env;
}
function ownerId(value){if(typeof value!=="string"||!UUID.test(value))throw Error("Invalid user");return value.toLowerCase();}
async function boundedJson(response){
  const length=Number(response.headers.get("content-length"));
  if(Number.isFinite(length)&&length>2_000_000)throw Error("WHOOP response too large");
  const text=await response.text();
  if(text.length>2_000_000)throw Error("WHOOP response too large");
  return JSON.parse(text);
}
async function concurrentlyRefreshed(db,id,previous,key,now,sleep){
  // Bounded wait (about 1.5 s) for the winning request to store its rotation.
  for(let attempt=0;attempt<4;attempt++){
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
  return openWhoopToken(row.encrypted_access_token,{userId:id,purpose:"access",key});
}
export async function whoopAccessToken(db, userId, env, {fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const id=ownerId(userId),key=config(env);
  if(!await activeMembership(db,id))throw Error("Membership required");
  const row=await db.prepare(
    "SELECT encrypted_access_token,encrypted_refresh_token,expires_at,scope FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  if(!row)throw Error("WHOOP connection required");
  const currentExpiry=Date.parse(row.expires_at);
  if(Number.isFinite(currentExpiry)&&currentExpiry>now()+60_000)
    return openWhoopToken(row.encrypted_access_token,{userId:id,purpose:"access",key});
  clientConfig(env);
  const refresh=await openWhoopToken(row.encrypted_refresh_token,{userId:id,purpose:"refresh",key});
  const form=new URLSearchParams({
    grant_type:"refresh_token",refresh_token:refresh,
    client_id:env.WHOOP_CLIENT_ID,client_secret:env.WHOOP_CLIENT_SECRET
  });
  const response=await fetcher(TOKEN_ENDPOINT,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:form,redirect:"manual",cache:"no-store",credentials:"omit",signal:timeout()
  });
  if(!response.ok){
    // WHOOP rotates refresh tokens: a parallel request that already used this
    // one makes ours fail. Use the access token that request stored, if any.
    const winner=await concurrentlyRefreshed(db,id,row,key,now,sleep);
    if(winner)return winner;
    throw Error("WHOOP refresh failed");
  }
  const tokens=await boundedJson(response);
  if(typeof tokens?.access_token!=="string"||tokens.access_token.length<1||
     !Number.isFinite(Number(tokens.expires_in))||Number(tokens.expires_in)<60 ||
     Number(tokens.expires_in)>31_536_000 ||
     (tokens.refresh_token!=null&&typeof tokens.refresh_token!=="string"))
    throw Error("Invalid WHOOP refresh response");
  const nextRefresh=tokens.refresh_token||refresh;
  const nextAccessEnvelope=await sealWhoopToken(tokens.access_token,{userId:id,purpose:"access",key});
  const nextRefreshEnvelope=await sealWhoopToken(nextRefresh,{userId:id,purpose:"refresh",key});
  const expiresAt=new Date(now()+Number(tokens.expires_in)*1000).toISOString();
  // Optimistic update: do not overwrite a connection already refreshed elsewhere.
  const result=await db.prepare(
    "UPDATE whoop_connections SET encrypted_access_token=?1,encrypted_refresh_token=?2,"+
    "expires_at=?3,scope=?4,updated_at=CURRENT_TIMESTAMP WHERE user_id=?5 AND encrypted_refresh_token=?6"
  ).bind(nextAccessEnvelope,nextRefreshEnvelope,expiresAt,
         typeof tokens.scope==="string"?tokens.scope:(row.scope||""),id,row.encrypted_refresh_token).run();
  if(!result.success||result.meta?.changes!==1){
    const winner=await concurrentlyRefreshed(db,id,row,key,now,sleep);
    if(winner)return winner;
    throw Error("WHOOP refresh raced or failed");
  }
  return tokens.access_token;
}
export async function callWhoop(db,userId,resource,env,opts={},deps={}){
  const spec=Object.hasOwn(resources,resource)?resources[resource]:null;
  if(!spec)throw Error("Unsupported WHOOP resource");
  const limit=opts.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error("Invalid limit");
  const nextToken=opts.next_token;
  if(nextToken!=null&&(!spec.history||typeof nextToken!=="string"||
                        (!/^[A-Za-z0-9._~+/-]{1,512}$/.test(nextToken)||nextToken.includes(".."))))
    throw Error("Invalid WHOOP cursor");
  const token=await whoopAccessToken(db,userId,env,deps);
  const search=new URLSearchParams();
  if(spec.history){
    search.set("limit",String(limit));
    if(nextToken)search.set("nextToken",nextToken);
  }
  const url=API+spec.path+(search.size?"?"+search:"");
  const response=await (deps.fetcher||fetch)(url,{
    method:"GET",headers:{authorization:"Bearer "+token,"accept":"application/json"},
    redirect:"manual",cache:"no-store",credentials:"omit",signal:timeout()
  });
  if(!response.ok)throw Error("WHOOP API request failed");
  const data=await boundedJson(response);
  if(!data||typeof data!=="object"||Array.isArray(data))throw Error("WHOOP response invalid");
  return data;
}
