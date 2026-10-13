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
