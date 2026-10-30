import {OAuthAuthorizationServer,authorizationErrorRedirect} from '@cloudflare/workers-oauth-provider';
import {OAuthStateStore} from '../../oauth/auth-server/src/oauth-state-store.mjs';
import {makeConsentFlow} from '../../oauth/auth-server/src/consent-flow.mjs';
const ORIGIN='https://auth.whooplens.tech',RESOURCE='https://whooplens.tech/mcp',USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const server=new OAuthAuthorizationServer({issuer:ORIGIN,resources:[RESOURCE],clientRegistrationEndpoint:'/oauth/register',scopesSupported:['mcp:read','offline_access'],onError:()=>{}});
export default {async fetch(request,bindings,ctx){
 const backend=bindings.MODE==='kv'?bindings.OAUTH_KV:new OAuthStateStore(bindings.DB);
 const store={get:backend.get.bind(backend),put:backend.put.bind(backend),delete:backend.delete.bind(backend),list:backend.list.bind(backend)};
 if(request.headers.get('x-synthetic-barrier')==='state'){
  if(bindings.MODE==='kv'){const put=store.put;store.put=async(k,v,o)=>{if(k.startsWith('grant:'))await bindings.GATE.fetch('https://gate.invalid/grantbarrier');return put(k,v,o);};}
  const get=store.get;store.get=async(k,t)=>{const value=await get(k,t);if(k.startsWith('transaction:')&&value)await bindings.GATE.fetch('https://gate.invalid/barrier');return value;};
 }
 if(request.headers.get('x-synthetic-pause')==='grant'){
  const put=store.put.bind(store);store.put=async(k,v,o)=>{if(k.startsWith('grant:'))await bindings.GATE.fetch('https://gate.invalid/pause');return put(k,v,o);};
 }
 const env={...bindings,OAUTH_KV:store,OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true'};
 const api=server.getOAuthApi(env),url=new URL(request.url);
 if(url.pathname==='/synthetic/setup'){
  const client=await api.createClient({clientName:'synthetic',redirectUris:['https://client.invalid/callback'],tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code']});
  const verifier='v'.repeat(43),challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const params=new URLSearchParams({client_id:client.clientId,redirect_uri:'https://client.invalid/callback',response_type:'code',scope:'mcp:read offline_access',state:'synthetic',resource:RESOURCE,code_challenge:challenge,code_challenge_method:'S256'});
  const parsed=await api.parseAuthRequest(new Request(ORIGIN+'/authorize?'+params));
  const start=await api.beginUpstream(parsed,{data:{verifier,grantedScopes:['mcp:read','offline_access'],offlineOffered:true}});
  return Response.json({client:client.clientId,verifier,state:start.state,cookie:start.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')});
 }
 if(url.pathname==='/synthetic/revoke'){
  const {user,grant}=await request.json();await api.revokeGrant(grant,user);return new Response(null,{status:204});
 }
 if(url.pathname==='/synthetic/validate'){
  const {token}=await request.json();return Response.json({valid:!!await server.validateToken(RESOURCE,token,env)});
 }
 if(url.pathname==='/oauth/upstream/callback'){
  const flow=makeConsentFlow({getOAuth:()=>api,errorRedirect:authorizationErrorRedirect,verifyIdentity:async()=>USER});
  return flow.callback(request,env);
 }
 return server.fetch(request,env,ctx);
}};
