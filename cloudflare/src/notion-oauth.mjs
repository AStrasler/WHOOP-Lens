import {notionAccount,notionConfigured,notionEnabled,notionTokenRequest,NotionError} from './notion-client.mjs';
import {notionHash,notionNonce,sealNotion} from './notion-crypto.mjs';
import {ACTIVE_MEMBER_SQL} from './storage.mjs';
export const NOTION_CALLBACK='/api/notion/callback';
export const NOTION_START='/api/notion/start';
const ORIGIN='https://whooplens.tech',REDIRECT=ORIGIN+NOTION_CALLBACK;
const COOKIE='__Host-wl_notion';
const validNonce=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
export async function createNotionAuthorization(db,userId,env,{now=Date.now}={}){
  if(!notionEnabled(env)||!notionConfigured(env))throw new NotionError('not_configured',503);
  await notionAccount(db,userId);
  const state=notionNonce(),generation=crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO notion_accounts(user_id,generation) VALUES(?1,?2) ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation')
      .bind(userId,generation),
    db.prepare('DELETE FROM notion_oauth_states WHERE user_id=?1 OR expires_at<=?2').bind(userId,now()),
    db.prepare('DELETE FROM notion_update_previews WHERE user_id=?1').bind(userId),
    db.prepare('INSERT INTO notion_oauth_states(state_hash,user_id,generation,expires_at) VALUES(?1,?2,?3,?4)')
      .bind(await notionHash(state),userId,generation,now()+600000)
  ]);
  return {authorization_url:ORIGIN+NOTION_START+'?state='+state,expires_in:600,
    instructions:'Open this private link yourself. Choose the Notion workspace and pages to share with WhoopLens. Do not forward it.'};
}
export async function disconnectNotion(db,userId){
  await notionAccount(db,userId);
  await db.batch([
    db.prepare('UPDATE notion_accounts SET generation=?1,credentials=NULL,workspace_id=NULL,config=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=?2').bind(crypto.randomUUID(),userId),
    db.prepare('DELETE FROM notion_oauth_states WHERE user_id=?1').bind(userId),
    db.prepare('DELETE FROM notion_update_previews WHERE user_id=?1').bind(userId)
  ]);
  return {disconnected:true,local_credentials_deleted:true,
    instructions:'WhoopLens has stopped using Notion. You can also revoke the connection in Notion settings. Notion pages were not deleted.'};
}
export async function notionOAuthHttp(request,env,{fetcher=fetch,now=Date.now}={}){
  const finish=(message,status=200,extra={})=>new Response(message,{status,headers:{...headers,...extra}});
  const clear={'set-cookie':COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'};
  try{
    if(!notionEnabled(env)||!notionConfigured(env)||!env.DB)return finish('Notion connection is not configured.',503);
    const url=new URL(request.url);
    if(url.origin!==ORIGIN||request.method!=='GET')return finish('Notion authorization unavailable.',400);
    if(url.searchParams.getAll('state').length!==1||!validNonce(url.searchParams.get('state')))return finish('This Notion link is invalid or expired.',400,clear);
    const hash=await notionHash(url.searchParams.get('state'));
    const row=await env.DB.prepare('SELECT * FROM notion_oauth_states WHERE state_hash=?1 AND expires_at>?2').bind(hash,now()).first();
    if(!row)return finish('This Notion link is invalid or expired.',400,clear);
    const account=await notionAccount(env.DB,row.user_id);
    if(account?.generation!==row.generation)return finish('This Notion link is invalid or expired.',400,clear);
    if(url.pathname===NOTION_START){
      const nonce=notionNonce();
      const write=await env.DB.prepare('UPDATE notion_oauth_states SET browser_hash=?1 WHERE state_hash=?2 AND browser_hash IS NULL AND expires_at>?3')
        .bind(await notionHash(nonce),hash,now()).run();
      if(write.meta?.changes!==1)return finish('This Notion link was already opened. Request a new connection link.',400,clear);
      const params=new URLSearchParams({client_id:env.NOTION_CLIENT_ID,redirect_uri:REDIRECT,response_type:'code',owner:'user',state:url.searchParams.get('state')});
      return finish(null,302,{location:'https://api.notion.com/v1/oauth/authorize?'+params,
        'set-cookie':COOKIE+'='+nonce+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'});
    }
    if(url.pathname!==NOTION_CALLBACK)return finish('Not found',404);
    const cookie=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    if(!validNonce(cookie)||await notionHash(cookie)!==row.browser_hash)return finish('Return using the browser where you opened the Notion link.',400,clear);
    const consumed=await env.DB.prepare('DELETE FROM notion_oauth_states WHERE state_hash=?1 AND browser_hash=?2 AND expires_at>?3 RETURNING user_id')
      .bind(hash,row.browser_hash,now()).first();
    if(!consumed)return finish('This Notion link is invalid or expired.',400,clear);
    if(url.searchParams.has('error'))return finish('Notion access was not granted. Your existing connection was kept.',200,clear);
    const code=url.searchParams.get('code');
    if(url.searchParams.getAll('code').length!==1||!code||code.length>2048)return finish('Notion authorization was not completed.',400,clear);
    const tokens=await notionTokenRequest(env,{grant_type:'authorization_code',code,redirect_uri:REDIRECT},{fetcher});
    if(typeof tokens.workspace_id!=='string'||!tokens.workspace_id||tokens.workspace_id.length>100)throw new NotionError('response_unavailable');
    const sealed=await sealNotion(tokens,row.user_id,'credentials',env);
    const saved=await env.DB.prepare(`UPDATE notion_accounts SET credentials=?1,workspace_id=?2,config=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE user_id=?3 AND generation=?4 AND EXISTS (${ACTIVE_MEMBER_SQL.replaceAll('?1','?3')})`)
      .bind(sealed,tokens.workspace_id,row.user_id,row.generation).run();
    if(saved.meta?.changes!==1)return finish('Your connection changed. Request a new Notion link if you still want to connect.',409,clear);
    return finish('Notion connected. Return to WhoopLens and choose your daily-log database.',200,clear);
  }catch{return finish('Notion authorization could not be completed. Your WHOOP connection was not changed.',503,clear);}
}
