import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {d1Database} from '../d1-sqlite.mjs';
import {makeConsentFlow} from '../../oauth/auth-server/src/consent-flow.mjs';

import {refreshGrantResult} from '../../oauth/auth-server/src/refresh-grant.mjs';
registerHooks({resolve(s,c,n){if(s==='cloudflare:workers')return {url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true};return n(s,c);}});
export const {OAuthAuthorizationServer,authorizationErrorRedirect}=await import('@cloudflare/workers-oauth-provider');
const {OAuthStateStore}=await import('../../oauth/auth-server/src/oauth-state-store.mjs');
export const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const ORIGIN='https://auth.whooplens.tech',RESOURCE='https://whooplens.tech/mcp';
export const req=(path,body,cookie='',method=body?'POST':'GET')=>new Request(ORIGIN+path,{method,headers:{cookie,origin:ORIGIN,...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined});
export const cookie=r=>r.headers.getSetCookie().filter(s=>!s.includes('Max-Age=0')).map(s=>s.split(';')[0]).join('; ');
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export class KV {
 records=new Map(); now=0; onGet=null; onPut=null; onDelete=null;
 async get(key,type){const rec=this.records.get(key);let v=rec&&rec.expires>this.now?rec.value:null;if(this.onGet)v=await this.onGet(key,v);return v===null?null:(type==='json'||type?.type==='json')?JSON.parse(v):v;}
 async put(key,value,options={}){if(this.onPut)await this.onPut(key,value);this.records.set(key,{value,expires:options.expirationTtl?this.now+options.expirationTtl:Infinity});}
 async delete(key){if(this.onDelete)await this.onDelete(key);this.records.delete(key);}
 async list({prefix=''}){return {keys:[...this.records.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
}
export async function fixture(){
 const strong=process.env.REPLAY_STORE!=='kv';const kv=new KV(),sqlite=new DatabaseSync(':memory:');
 for(const name of ['0001_initial.sql','0005_access_identity_links.sql'])sqlite.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
 if(strong)sqlite.exec(readFileSync(new URL('../../migrations/0021_oauth_security_state.sql',import.meta.url),'utf8'));
 for(const [id,active] of [[A,1],[B,1],[C,0]]){
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,active);
  sqlite.prepare('INSERT INTO access_identity_links VALUES(?,?,?,1,?)').run('https://synthetic.cloudflareaccess.com',id,id,'2026-10-30');
 }
 const env={OAUTH_KV:kv,DB:d1Database(sqlite),OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true',ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUD:'a'.repeat(64)};
 const instances=[0,1].map(()=>new OAuthAuthorizationServer({issuer:ORIGIN,resources:[RESOURCE],scopesSupported:['mcp:read','offline_access'],clientRegistrationEndpoint:'/oauth/register',refreshTokenTTL:2592000,refreshTokenIdleTTL:2592000,onError:()=>{},tokenExchangeCallback:input=>{
  const decision=refreshGrantResult(input);return {...decision,accessTokenProps:{userId:input.props.userId}};
 }}));
 function freshEnv(){
  if(!strong)return env;
  const store=new OAuthStateStore(env.DB,{now:()=>Date.now()+kv.now*1000});
  return {...env,OAUTH_KV:{
   async get(k,t){let v=await store.get(k);if(kv.onGet)v=await kv.onGet(k,v);return v===null?null:(t==='json'||t?.type==='json')?JSON.parse(v):v;},
   async put(k,v,o){if(kv.onPut)await kv.onPut(k,v);return store.put(k,v,o);},
   async delete(k){if(kv.onDelete)await kv.onDelete(k);return store.delete(k);},
   list:o=>store.list(o)
  }};
 }
 const apis=instances.map(s=>({revokeGrant:(g,u)=>s.getOAuthApi(freshEnv()).revokeGrant(g,u),createClient:o=>s.getOAuthApi(freshEnv()).createClient(o)})),pending=[];
 const ctx={waitUntil:p=>pending.push(p)};
 const client=await apis[0].createClient({clientName:'synthetic replay',redirectUris:['https://client.invalid/callback'],tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code']});
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'synthetic',alg:'RS256',use:'sig'};
 const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 async function jwt(user=A){const now=Math.floor(Date.now()/1000);const str=enc({alg:'RS256',kid:'synthetic'})+'.'+enc({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUD],sub:user,email:'member@example.invalid',type:'app',iat:now-1,exp:now+300});return str+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(str))).toString('base64url');}
 const {verifyUpstreamCode}=await import('../../oauth/auth-server/src/upstream.mjs');
 let verified=0;
 const flows=instances.map(instance=>makeConsentFlow({getOAuth:env=>instance.getOAuthApi(env),errorRedirect:authorizationErrorRedirect,verifyIdentity:args=>verifyUpstreamCode({...args,fetcher:async()=>{verified++;return Response.json({keys:[jwk]});}})}));
 async function start(index=0){
  const verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',Buffer.from(verifier))).toString('base64url');
  const query=new URLSearchParams({client_id:client.clientId,redirect_uri:'https://client.invalid/callback',response_type:'code',scope:'mcp:read offline_access',state:'synthetic-client-state',resource:RESOURCE,code_challenge:challenge,code_challenge_method:'S256'});
  const page=await flows[index].authorize(req('/authorize?'+query),freshEnv());assert.equal(page.status,200);
  const handle=(await page.text()).match(/name="handle" value="([^"]+)"/)[1];
  const approve=await flows[index].authorize(req('/authorize',new URLSearchParams([['handle',handle],['decision','approve'],['scope','mcp:read'],['scope','offline_access']]),cookie(page)),freshEnv());
  assert.equal(approve.status,302);return {path:new URL(approve.headers.get('location')).pathname+new URL(approve.headers.get('location')).search,cookie:cookie(approve),verifier};
 }
 async function callback(a,index=0,user=A,extra={}){const request=req(a.path,null,extra.cookie??a.cookie);request.headers.set('cf-access-jwt-assertion',await jwt(user));if(extra.early)request.headers.set('Early-Data','1');return flows[index].callback(request,freshEnv());}
 async function send(body,index=0){return instances[index].fetch(req('/oauth/token',{client_id:client.clientId,resource:RESOURCE,...body}),freshEnv(),ctx);}
 async function exchange(a,r,index=0){return send({grant_type:'authorization_code',code:new URL(r.headers.get('location')).searchParams.get('code'),code_verifier:a.verifier,redirect_uri:'https://client.invalid/callback'},index);}
 async function issue(user=A){const a=await start();const r=await callback(a,0,user);assert.equal(r.status,302);const t=await exchange(a,r);assert.equal(t.status,200);return t.json();}
 const refresh=(token,index=0)=>send({grant_type:'refresh_token',refresh_token:token},index);
 return {kv,env,storageEnv:freshEnv,strong,sqlite,instances,apis,flows,client,start,callback,send,exchange,issue,refresh,verified:()=>verified,async close(){await Promise.allSettled(pending);sqlite.close();}};
}
