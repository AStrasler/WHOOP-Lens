import {
  OAuthAuthorizationServer,authorizationErrorRedirect
} from '@cloudflare/workers-oauth-provider';
import {WorkerEntrypoint} from 'cloudflare:workers';
import {makeConsentFlow} from './consent-flow.mjs';
// The Cloudflare OAuth provider issues tokens only after an explicit member
// consent and independently validated Supabase OAuth PKCE redirect.
// All routes remain disabled until a separately approved staging rollout.
export const ISSUER='https://auth.whooplens.tech';
export const RESOURCE='https://whooplens.tech/mcp';
const server=new OAuthAuthorizationServer({
  issuer:ISSUER,resources:[RESOURCE],
  scopesSupported:['mcp:read','offline_access'],
  clientIdMetadataDocumentEnabled:true,
  clientRegistrationEndpoint:'/oauth/register'
});
const flow=makeConsentFlow({
  getOAuth:env=>server.getOAuthApi(env),
  errorRedirect:authorizationErrorRedirect
});
export default class WhoopLensAuthServer extends WorkerEntrypoint {
  fetch(request){
    if(this.env.OAUTH_SERVER_ENABLED!=='true'||
       this.env.OAUTH_CONSENT_ENABLED!=='true')
      return new Response('WHOOP Lens OAuth is not activated',{
        status:503,headers:{'cache-control':'no-store'}
      });
    const path=new URL(request.url).pathname;
    if(path==='/authorize')return flow.authorize(request,this.env);
    if(path==='/oauth/upstream/callback')return flow.callback(request,this.env);
    return server.fetch(request,this.env,this.ctx);
  }
  validateToken(resource,token){
    if(this.env.OAUTH_SERVER_ENABLED!=='true'||
       this.env.OAUTH_CONSENT_ENABLED!=='true')return null;
    return server.validateToken(resource,token,this.env);
  }
}
