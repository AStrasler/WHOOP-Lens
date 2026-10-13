// Cloudflare-only envelope for future WHOOP OAuth reauthorization.
// No live Supabase token or encryption key is migrated by this module.
// Configure WHOOP_TOKEN_AES256_KEY as a 32-byte base64url secret out of band.
// Bind the ciphertext to the verified user and token purpose (AEAD).
const enc=new TextEncoder(),dec=new TextDecoder();
const userPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function base64Url(bytes) {
  let raw="";
  for(const byte of bytes) raw+=String.fromCharCode(byte);
  return btoa(raw).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
function fromBase64Url(value) {
  if(typeof value!=="string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid token envelope");
  const normalized=value.replaceAll("-","+").replaceAll("_","/");
  const raw=atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,"="));
  return Uint8Array.from(raw,ch=>ch.charCodeAt(0));
}
async function aesKey(encoded) {
  const bytes=fromBase64Url(encoded);
  if(bytes.length!==32)throw Error("Cloudflare key must be 256 bits");
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
function context(userId,purpose) {
  if(typeof userId!=="string"||!userPattern.test(userId)||!["access","refresh"].includes(purpose))
    throw Error("Invalid token owner or purpose");
  return enc.encode("WHOOP-Lens/Cloudflare/v1/"+userId.toLowerCase()+"/"+purpose);
}
export async function sealWhoopToken(rawToken,{userId,purpose,key}) {
  if(typeof rawToken!=="string"||rawToken.length<1||rawToken.length>16384)
    throw Error("Invalid WHOOP token");
  const cipherKey=await aesKey(key);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt(
    {name:"AES-GCM",iv,additionalData:context(userId,purpose),tagLength:128},
    cipherKey,enc.encode(rawToken)
  );
  return "v1."+base64Url(iv)+"."+base64Url(new Uint8Array(ciphertext));
}
export async function openWhoopToken(envelope,{userId,purpose,key}) {
  if(typeof envelope!=="string"||envelope.length>24000)throw Error("Invalid token envelope");
  const parts=envelope.split(".");
  if(parts.length!==3||parts[0]!=="v1")throw Error("Invalid token envelope");
  const iv=fromBase64Url(parts[1]),data=fromBase64Url(parts[2]);
  if(iv.length!==12||data.length<17)throw Error("Invalid token envelope");
  const cipherKey=await aesKey(key);
  // A wrong key, user, purpose, or modified ciphertext fails authentication.
  const plaintext=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv,additionalData:context(userId,purpose),tagLength:128},
    cipherKey,data
  );
  return dec.decode(plaintext);
}

// Key rotation. k1 is WHOOP_TOKEN_AES256_KEY, k2 is WHOOP_TOKEN_AES256_KEY_NEXT.
// Envelopes sealed with k2 are "v2.k2.<iv>.<ct>". Legacy "v1.<iv>.<ct>" envelopes
// carry no key id and are tried with k2 first, then k1.
// While NEXT is absent, sealing stays on v1 with k1, unchanged from before.
export function tokenKeyring(env){
  const old=typeof env?.WHOOP_TOKEN_AES256_KEY==="string"?env.WHOOP_TOKEN_AES256_KEY:null;
  const next=typeof env?.WHOOP_TOKEN_AES256_KEY_NEXT==="string"?env.WHOOP_TOKEN_AES256_KEY_NEXT:null;
  if(!old&&!next)throw Error("Token key unavailable");
  return {k1:old,k2:next,current:next?"k2":"k1"};
}
export async function sealWithKeyring(rawToken,{userId,purpose,keys}){
  if(keys.current==="k2"){
    const legacy=await sealWhoopToken(rawToken,{userId,purpose,key:keys.k2});
    return "v2.k2."+legacy.slice(3);
  }
  return sealWhoopToken(rawToken,{userId,purpose,key:keys.k1});
}
export function envelopeKeyId(envelope){
  if(typeof envelope!=="string")return null;
  if(envelope.startsWith("v2.k2."))return "k2";
  if(envelope.startsWith("v2.k1."))return "k1";
  if(envelope.startsWith("v1."))return "legacy";
  return null;
}
// Returns {token,key}. key is the id that opened it ("k1" or "k2").
export async function openWithKeyring(envelope,{userId,purpose,keys}){
  const id=envelopeKeyId(envelope);
  if(id==="k2"||id==="k1"){
    const key=keys[id];
    if(!key)throw Error("Token key unavailable");
    const token=await openWhoopToken("v1."+envelope.slice(6),{userId,purpose,key});
    return {token,key:id};
  }
  if(id!=="legacy")throw Error("Invalid token envelope");
  if(keys.k2){
    try{return {token:await openWhoopToken(envelope,{userId,purpose,key:keys.k2}),key:"k2"};}
    catch{/* fall back to k1 */}
  }
  if(!keys.k1)throw Error("Token key unavailable");
  return {token:await openWhoopToken(envelope,{userId,purpose,key:keys.k1}),key:"k1"};
}
// True when an envelope should be resealed with the current key.
export function needsReseal(envelope,openedWith,keys){
  if(keys.current!=="k2")return false;
  return openedWith!=="k2"||envelopeKeyId(envelope)!=="k2";
}
