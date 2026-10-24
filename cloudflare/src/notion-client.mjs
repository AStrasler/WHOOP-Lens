import {readBounded} from './bounded-body.mjs';
import {activeMembership} from './storage.mjs';
import {openNotion,sealNotion} from './notion-crypto.mjs';
import {SECRET_RULES} from './secrets.mjs';
export const NOTION_VERSION='2026-03-11';
export class NotionError extends Error {
  constructor(code,status=400,retryAfter=null){super(code);this.name='NotionError';this.code=code;this.status=status;this.retryAfter=retryAfter;}
}
export function notionEnabled(env){return env?.NOTION_ENABLED==='true';}
export function notionConfigured(env){
  return SECRET_RULES.NOTION_CLIENT_ID(env?.NOTION_CLIENT_ID)&&
    SECRET_RULES.NOTION_CLIENT_SECRET(env?.NOTION_CLIENT_SECRET)&&
    SECRET_RULES.NOTION_TOKEN_AES256_KEY(env?.NOTION_TOKEN_AES256_KEY);
}
export async function notionAccount(db,userId){
  if(!await activeMembership(db,userId))throw new NotionError('membership_required',403);
  return db.prepare('SELECT * FROM notion_accounts WHERE user_id=?1').bind(userId).first();
}
export async function notionJson(response){
  const body=await readBounded(response,500000);
  if(body.error)throw new NotionError('response_unavailable',502);
  try{return JSON.parse(body.text);}catch{throw new NotionError('response_unavailable',502);}
}
function statusError(response){
  const seconds=response.headers.get('retry-after');
  const retryAfter=/^\d{1,6}$/.test(seconds||'')?Math.min(Number(seconds),3600):null;
  return new NotionError(response.status===429?'rate_limited':response.status===401?'authorization_required':
    response.status===403?'permission_denied':response.status===404?'not_shared_or_missing':'service_unavailable',response.status,retryAfter);
}
export async function notionTokenRequest(env,body,{fetcher=fetch}={}){
  if(!notionConfigured(env))throw new NotionError('not_configured',503);
  let response;
  try{response=await fetcher('https://api.notion.com/v1/oauth/token',{method:'POST',
    headers:{authorization:'Basic '+btoa(env.NOTION_CLIENT_ID+':'+env.NOTION_CLIENT_SECRET),'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(12000)});}
  catch{throw new NotionError('service_unavailable',503);}
  if(!response.ok)throw statusError(response);
  const tokens=await notionJson(response);
  if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>16000||
     typeof tokens.refresh_token!=='string'||!tokens.refresh_token||tokens.refresh_token.length>16000)
    throw new NotionError('response_unavailable',502);
  return tokens;
}
export async function notionRequest(db,userId,env,path,{method='GET',body,fetcher=fetch,expectedGeneration,expectedConfigRevision,now=Date.now}={}){
  if(!notionEnabled(env))throw new NotionError('disabled',503);
  if(!/^\/(?:search|data_sources\/[a-f0-9-]{36}(?:\/query)?|pages\/[a-f0-9-]{36}|blocks\/[a-f0-9-]{36}\/children(?:\?[^#]*)?)$/i.test(path))
    throw new NotionError('invalid_target');
  let row=await notionAccount(db,userId);
  if(!row?.credentials)throw new NotionError('connection_required',409);
  if(expectedGeneration!==undefined&&row.generation!==expectedGeneration)throw new NotionError('connection_changed',409);
  if(expectedConfigRevision!==undefined&&row.config_revision!==expectedConfigRevision)throw new NotionError('connection_changed',409);
  let tokens=await openNotion(row.credentials,userId,'credentials',env);
  const send=async()=>{
    const current=await notionAccount(db,userId);
    if(current?.generation!==row.generation||!current.credentials)throw new NotionError('connection_changed',409);
    if(expectedConfigRevision!==undefined&&current.config_revision!==expectedConfigRevision)throw new NotionError('connection_changed',409);
    try{return await fetcher('https://api.notion.com/v1'+path,{method,
      headers:{authorization:'Bearer '+tokens.access_token,'notion-version':NOTION_VERSION,'content-type':'application/json','accept':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(12000)});}
    catch(error){if(error instanceof NotionError)throw error;throw new NotionError('service_unavailable',503);}
  };
  let response=await send();
  // A definite 401 rejected the operation before authorization. Renew once.
  // Never repeat a write on transport failures, 5xx, or unreadable responses.
  if(response.status===401){
    const current=await notionAccount(db,userId);
    if(current?.generation!==row.generation||!current.credentials)throw new NotionError('connection_changed',409);
    if(current.credentials!==row.credentials){tokens=await openNotion(current.credentials,userId,'credentials',env);row=current;}
    else{
      const lease=crypto.randomUUID();
      const claimed=await db.prepare('UPDATE notion_accounts SET refresh_lock=?1,refresh_lock_until=?2 WHERE user_id=?3 AND generation=?4 AND credentials=?5 AND refresh_lock_until<=?6')
        .bind(lease,now()+30000,userId,row.generation,row.credentials,now()).run();
      if(claimed.meta?.changes!==1)throw new NotionError('refresh_busy',503,1);
      try{
        const updated=await notionTokenRequest(env,{grant_type:'refresh_token',refresh_token:tokens.refresh_token},{fetcher});
        const sealed=await sealNotion(updated,userId,'credentials',env);
        const result=await db.prepare('UPDATE notion_accounts SET credentials=?1,refresh_lock=NULL,refresh_lock_until=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=?2 AND generation=?3 AND credentials=?4 AND refresh_lock=?5')
          .bind(sealed,userId,row.generation,row.credentials,lease).run();
        if(result.meta?.changes!==1)throw new NotionError('connection_changed',409);
        tokens=updated;row={...row,credentials:sealed};
      }finally{
        await db.prepare('UPDATE notion_accounts SET refresh_lock=NULL,refresh_lock_until=0 WHERE user_id=?1 AND refresh_lock=?2').bind(userId,lease).run();
      }
    }
    response=await send();
  }
  if(!response.ok)throw statusError(response);
  const result=await notionJson(response);
  const current=await notionAccount(db,userId);
  if(current?.generation!==row.generation||!current.credentials)throw new NotionError('connection_changed',409);
  if(expectedConfigRevision!==undefined&&current.config_revision!==expectedConfigRevision)throw new NotionError('connection_changed',409);
  return result;
}
