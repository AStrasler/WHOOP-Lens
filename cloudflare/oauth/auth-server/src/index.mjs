import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { makeConsentFlow } from './consent-flow.mjs';
// Split OAuth issuer; Supabase remains the identity source during migration.
export const ISSUER='https://auth.whooplens.tech';
export const RESOURCE='https://whooplens.tech/mcp';
const server=new OAuthAuthorizationServer({
  issuer:ISSUER,resources:[RESOURCE],
  scopesSupported:['mcp:read','offline_access'],
  clientIdMetadataDocumentEnabled:true,
  clientRegistrationEndpoint:'/oauth/register'
});
const authorize=makeConsentFlow({getOAuth:env=>server.getOAuthApi(env)});
export default class WhoopLensAuthServer extends WorkerEntrypoint {
  fetch(request){
    if(this.env.OAUTH_SERVER_ENABLED!=='true'||this.env.OAUTH_CONSENT_ENABLED!=='true')
      return new Response('WHOOP Lens OAuth is not activated',{status:503,headers:{'cache-control':'no-store'}});
    if(new URL(request.url).pathname==='/authorize')return authorize(request,this.env);
    return server.fetch(request,this.env,this.ctx);
  }
  validateToken(resource,token){
    if(this.env.OAUTH_SERVER_ENABLED!=='true'||this.env.OAUTH_CONSENT_ENABLED!=='true')return null;
    return server.validateToken(resource,token,this.env);
  }
}
