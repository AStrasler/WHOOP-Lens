// Sealed continuation cursors for WHOOP history pagination.
//
// WHOOP's raw nextToken never leaves the Worker. The client gets an opaque
// AES-GCM envelope whose additional data binds it to the authenticated member,
// the history endpoint and its query window. The plaintext carries the WHOOP
// token, an expiry and the page depth. A cursor replayed by another member, on
// another endpoint, after expiry, or after any modification fails to open and
// no WHOOP request is made.
//
// The key is derived with HKDF from the existing WHOOP_TOKEN_AES256_KEY (or
// WHOOP_TOKEN_AES256_KEY_NEXT while a rotation is staged), with a cursor-only
// salt and info, so no new secret is needed and the derived key is never usable
// for the stored-token envelopes.
import { tokenKeyring } from "./token-crypto.mjs";

export const CURSOR_TTL_MS=60*60*1000;
// Pages per call when auto_page is true (4 x 25 = 100 records), unchanged.
export const AUTO_PAGE_MAX_PAGES=4;
export const AUTO_PAGE_SIZE=25;
// Depth cap for one pagination sequence across calls (25,000 records at 25 per page).
export const SEQUENCE_MAX_PAGES=1000;
export const CURSOR_MAX_LENGTH=2048;
const CURSOR_SHAPE=/^wlc1\.(k1|k2)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,2000})$/;
// WHOOP tokens: URL-safe characters, optional base64 padding, no path traversal.
const WHOOP_TOKEN=/^[A-Za-z0-9._~+/-]{1,512}={0,2}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCES=new Set(["recovery","sleep","workouts","cycles"]);
const enc=new TextEncoder(),dec=new TextDecoder();

export class CursorError extends Error{
  constructor(reason){super(reason==="expired"?"Pagination cursor expired":"Pagination cursor invalid");this.reason=reason;}
}
export function validWhoopToken(value){
  return typeof value==="string"&&value.length<=514&&WHOOP_TOKEN.test(value)&&!value.includes("..");
}
// Shape-only check used by argument validation (no key access).
export function cursorShapeOk(value){
  return typeof value==="string"&&value.length<=CURSOR_MAX_LENGTH&&CURSOR_SHAPE.test(value);
}
function b64u(bytes){
  let raw="";for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
function unb64u(value){
  const n=value.replaceAll("-","+").replaceAll("_","/");
  const raw=atob(n.padEnd(Math.ceil(n.length/4)*4,"="));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function cursorKey(secret){
  if(typeof secret!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(secret))throw new CursorError("key");
  const raw=unb64u(secret);
  if(raw.length!==32)throw new CursorError("key");
  const base=await crypto.subtle.importKey("raw",raw,"HKDF",false,["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"HKDF",hash:"SHA-256",salt:enc.encode("WHOOP-Lens/history-cursor/salt/v1"),info:enc.encode("WHOOP-Lens/history-cursor/aes-gcm/v1")},
    base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
function binding(kid,userId,resource,query){
  if(typeof userId!=="string"||!UUID.test(userId))throw new CursorError("owner");
  if(!RESOURCES.has(resource))throw new CursorError("resource");
  const window={start:query?.start??null,end:query?.end??null};
  return enc.encode(["WHOOP-Lens/history-cursor/v1",kid,userId.toLowerCase(),resource,JSON.stringify(window)].join("\n"));
}
function keyring(env){
  try{return tokenKeyring(env);}catch{throw new CursorError("key");}
}
// generation is the member's WHOOP connection generation (migration 0016) at
// the start of the call; null when that table is not available, in which case
// the cursor is sealed without one (the format issued before the migration).
export async function sealCursor({env,userId,resource,query,whoopToken,depth,generation=null,now=Date.now}){
  if(!validWhoopToken(whoopToken))throw new CursorError("upstream");
  if(!Number.isSafeInteger(depth)||depth<1||depth>SEQUENCE_MAX_PAGES)throw new CursorError("depth");
  if(generation!==null&&(!Number.isSafeInteger(generation)||generation<0))throw new CursorError("generation");
  const keys=keyring(env),kid=keys.current;
  const key=await cursorKey(keys[kid]);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const sealed={t:whoopToken,x:now()+CURSOR_TTL_MS,d:depth};
  if(generation!==null)sealed.g=generation;
  const body=enc.encode(JSON.stringify(sealed));
  const ct=new Uint8Array(await crypto.subtle.encrypt(
    {name:"AES-GCM",iv,additionalData:binding(kid,userId,resource,query),tagLength:128},key,body));
  return "wlc1."+kid+"."+b64u(iv)+"."+b64u(ct);
}
export async function openCursor({env,userId,resource,query,cursor,now=Date.now}){
  const m=typeof cursor==="string"&&cursor.length<=CURSOR_MAX_LENGTH?CURSOR_SHAPE.exec(cursor):null;
  if(!m)throw new CursorError("malformed");
  const keys=keyring(env),kid=m[1];
  if(!keys[kid])throw new CursorError("invalid");
  let plain;
  try{
    const key=await cursorKey(keys[kid]);
    plain=await crypto.subtle.decrypt(
      {name:"AES-GCM",iv:unb64u(m[2]),additionalData:binding(kid,userId,resource,query),tagLength:128},
      key,unb64u(m[3]));
  }catch(error){
    if(error instanceof CursorError&&error.reason!=="key")throw error;
    // Wrong member, wrong endpoint or query, tampered bytes and unknown keys
    // all look the same to the caller.
    throw new CursorError("invalid");
  }
  let payload;
  try{payload=JSON.parse(dec.decode(plain));}catch{throw new CursorError("invalid");}
  if(!payload||!validWhoopToken(payload.t)||!Number.isSafeInteger(payload.x)||
     !Number.isSafeInteger(payload.d)||payload.d<1||payload.d>SEQUENCE_MAX_PAGES||
     (payload.g!==undefined&&(!Number.isSafeInteger(payload.g)||payload.g<0)))
    throw new CursorError("invalid");
  if(now()>=payload.x)throw new CursorError("expired");
  // Every cursor is sealed exactly CURSOR_TTL_MS before it expires. A cursor
  // without g predates migration 0016 and belongs to generation 0.
  return {whoopToken:payload.t,depth:payload.d,issuedAt:payload.x-CURSOR_TTL_MS,generation:payload.g??0};
}
// The member's WHOOP connection state, in one D1 read. It is read once before
// any WHOOP request (to check an incoming cursor and to stamp the outgoing
// one) and again after every page (to drop a page fetched while it changed):
// - revoked_at (migration 0008): the raw disconnect marker, null when the
//   member never disconnected. A disconnect ends every sequence started
//   before it.
// - generation (migration 0016): bumped by every OAuth callback that stores
//   credentials (including a reconnect without a disconnect) and every
//   disconnect. With 0016 applied it alone detects both changes; revoked_at is
//   still compared because a disconnect made by code that predates 0016 (or
//   while it was rolled back) changes only the marker. Both come from the
//   same read, so keeping both costs nothing.
// Without the 0016 table only revoked_at is used and generation is null,
// which is the behaviour before 0016.
async function connectionState(db,userId){
  const id=userId.toLowerCase();
  try{
    const row=await db.prepare(
      "SELECT (SELECT revoked_at FROM whoop_credential_revocations WHERE user_id=?1) AS revoked_at,"+
      "(SELECT generation FROM whoop_connection_generations WHERE user_id=?1) AS generation"
    ).bind(id).first();
    return {revokedAt:row?.revoked_at==null?null:String(row.revoked_at),generation:readGeneration(row?.generation)};
  }catch(error){
    if(error instanceof CursorError)throw error;
    if(!/no such table/i.test(String(error?.message||""))||!String(error.message).includes("whoop_connection_generations"))throw error;
  }
  const row=await db.prepare(
    "SELECT revoked_at FROM whoop_credential_revocations WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  return {revokedAt:row?.revoked_at==null?null:String(row.revoked_at),generation:null};
}
// No row is generation 0. An unreadable value fails closed.
function readGeneration(value){
  if(value==null)return 0;
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0)throw new CursorError("revoked");
  return n;
}
function sameState(a,b){return a.revokedAt===b.revokedAt&&a.generation===b.generation;}
// A cursor must be issued after the last disconnect and under the current
// generation. revoked_at is "YYYY-MM-DD HH:MM:SS[.mmm]" (UTC); second-precision
// markers (written before millisecond stamps) reject the whole second, and an
// unreadable marker fails closed.
function assertCurrent(state,opened){
  const marker=state.revokedAt;
  if(marker!=null){
    const precise=/\.\d{3}$/.test(marker);
    const revoked=Date.parse(marker.includes("T")?marker:marker.replace(" ","T")+"Z");
    if(!Number.isFinite(revoked)||opened.issuedAt<=revoked+(precise?0:999))throw new CursorError("revoked");
  }
  if(state.generation!==null&&opened.generation!==state.generation)throw new CursorError("revoked");
}

function pageOk(batch,max){
  return batch!==null&&typeof batch==="object"&&!Array.isArray(batch)&&
    Array.isArray(batch.records)&&batch.records.length<=max;
}
// Reads one or more WHOOP history pages for the authenticated member and
// returns a sealed cursor for the next page. userId must come from the
// verified identity; nothing in the request arguments can select a member.
export async function readHistoryPages({db,userId,resource,env,whoopRequest,limit,cursor,auto,now=Date.now}){
  const query={start:null,end:null};
  let token=null,depth=0;
  // Read once before any WHOOP request; rechecked after every page.
  const state=await connectionState(db,userId);
  const generation=state.generation;
  if(cursor!=null){
    const opened=await openCursor({env,userId,resource,query,cursor,now});
    assertCurrent(state,opened);
    token=opened.whoopToken;depth=opened.depth;
  }
  // A disconnect or reconnect that commits while a page is in flight is
  // visible here: the marker/generation and the credential change are one D1
  // batch. Such a page may already come from the next connection.
  const unchanged=async()=>{
    try{return sameState(await connectionState(db,userId),state);}
    catch(error){if(error instanceof CursorError)return false;throw error;}
  };
  if(!auto)return readOnePage({db,userId,resource,env,whoopRequest,limit,token,depth,query,generation,now,unchanged});
  const records=[];
  const seen=new Set(token?[token]:[]);
  let pages=0,reason=null,retryAfter=null,scope=null;
  while(pages<AUTO_PAGE_MAX_PAGES){
    if(depth>=SEQUENCE_MAX_PAGES){reason="page_limit";break;}
    let batch;
    try{batch=await whoopRequest(db,userId,resource,env,{limit:AUTO_PAGE_SIZE,next_token:token});}
    catch(error){
      // Nothing retrieved yet: surface the failure exactly as before.
      if(pages===0)throw error;
      reason=error?.status===429?"rate_limited":"upstream_error";
      if(reason==="rate_limited"&&Number.isSafeInteger(error?.retryAfter))retryAfter=error.retryAfter;
      // "member": this account's WHOOP Lens share (member-rate-limit.mjs);
      // "whoop": WHOOP throttled the app.
      if(reason==="rate_limited")scope=error?.memberLimit===true?"member":"whoop";
      break;
    }
    if(!pageOk(batch,AUTO_PAGE_SIZE)){
      if(pages===0)throw Error(batch&&Array.isArray(batch.records)?"WHOOP page oversized":"Unexpected WHOOP page");
      reason="upstream_error";break;
    }
    if(!await unchanged()){
      // Drop this page: it may belong to a newly connected WHOOP account.
      if(pages===0)throw Error("WHOOP connection changed");
      token=null;reason="connection_changed";break;
    }
    records.push(...batch.records);
    pages++;depth++;
    const next=batch.next_token??null;
    if(next===null){token=null;break;}
    if(!validWhoopToken(next)||seen.has(next)){token=null;reason="invalid_upstream_cursor";break;}
    seen.add(next);token=next;
  }
  if(token!==null&&reason===null&&depth>=SEQUENCE_MAX_PAGES)reason="page_limit";
  // Only an upstream failure mid-sequence keeps a cursor, so the next call
  // resumes at the page that failed. A depth limit or a bad WHOOP cursor ends it.
  if(reason!==null&&reason!=="upstream_error"&&reason!=="rate_limited")token=null;
  const out={records,
    next_token:token===null?null:await sealCursor({env,userId,resource,query,whoopToken:token,depth,generation,now}),
    complete:token===null&&reason===null,pages_fetched:pages};
  if(reason)out.incomplete_reason=reason;
  if(retryAfter!=null)out.retry_after_seconds=retryAfter;
  if(scope)out.rate_limit_scope=scope;
  return out;
}
// One page, as before: the WHOOP response passes through except that its
// next_token is replaced by a sealed cursor (or null when it is unusable) and
// complete says whether the sequence has ended.
async function readOnePage({db,userId,resource,env,whoopRequest,limit,token,depth,query,generation,now,unchanged}){
  if(depth>=SEQUENCE_MAX_PAGES)return {records:[],next_token:null,complete:false,incomplete_reason:"page_limit"};
  const batch=await whoopRequest(db,userId,resource,env,{limit,next_token:token});
  if(!await unchanged())throw Error("WHOOP connection changed");
  // Same page validation as auto_page: a malformed or oversized page is an
  // error, never a "complete" history.
  if(!pageOk(batch,limit))throw Error(batch&&Array.isArray(batch.records)?"WHOOP page oversized":"Unexpected WHOOP page");
  const next=batch.next_token??null;
  const out={...batch};
  // Same completion signal as auto_page, so "paginate until complete is true" works.
  if(next===null){out.next_token=null;out.complete=true;return out;}
  if(!validWhoopToken(next)||next===token||depth+1>=SEQUENCE_MAX_PAGES){
    out.next_token=null;out.complete=false;
    out.incomplete_reason=depth+1>=SEQUENCE_MAX_PAGES&&validWhoopToken(next)&&next!==token?"page_limit":"invalid_upstream_cursor";
    return out;
  }
  out.next_token=await sealCursor({env,userId,resource,query,whoopToken:next,depth:depth+1,generation,now});
  out.complete=false;
  return out;
}
