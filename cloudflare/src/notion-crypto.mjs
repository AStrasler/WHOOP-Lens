// Separate Notion key and AEAD namespace; never reuse WHOOP token envelopes.
const enc=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function bytes(s){
  if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('Notion encryption unavailable');
  return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
}
async function context(userId,purpose,env){
  if(!/^[a-f0-9-]{36}$/i.test(userId)||!['credentials','preview'].includes(purpose))throw Error('Notion encryption unavailable');
  const raw=bytes(env?.NOTION_TOKEN_AES256_KEY);
  if(raw.length!==32)throw Error('Notion encryption unavailable');
  return {key:await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']),
    additionalData:enc.encode('WHOOP-Lens/Notion/v1/'+userId.toLowerCase()+'/'+purpose)};
}
export function notionNonce(){return b64(crypto.getRandomValues(new Uint8Array(32)));}
export async function notionHash(value){return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))));}
export async function sealNotion(value,userId,purpose,env){
  const {key,additionalData}=await context(userId,purpose,env),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,enc.encode(JSON.stringify(value)));
  return 'n1.'+b64(iv)+'.'+b64(new Uint8Array(data));
}
export async function openNotion(value,userId,purpose,env){
  if(typeof value!=='string'||value.length>100000)throw Error('Notion encryption unavailable');
  const [version,iv,data,...extra]=value.split('.');
  if(version!=='n1'||extra.length)throw Error('Notion encryption unavailable');
  const c=await context(userId,purpose,env),nonce=bytes(iv);
  if(nonce.length!==12)throw Error('Notion encryption unavailable');
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:c.additionalData},c.key,bytes(data))));
}
