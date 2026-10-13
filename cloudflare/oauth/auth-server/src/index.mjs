import {
  OAuthAuthorizationServer,authorizationErrorRedirect,OAuthError
} from '@cloudflare/workers-oauth-provider';
import {WorkerEntrypoint} from 'cloudflare:workers';
import {makeConsentFlow} from './consent-flow.mjs';
import {refreshGrantResult} from './refresh-grant.mjs';
// The Cloudflare OAuth provider issues tokens only after an explicit member
// consent and independently validated Cloudflare Access application JWT.
// All routes remain disabled until a separately approved staging rollout.
export const ISSUER='https://auth.whooplens.tech';
export const RESOURCE='https://whooplens.tech/mcp';
export const server=new OAuthAuthorizationServer({
  issuer:ISSUER,resources:[RESOURCE],
  scopesSupported:['mcp:read','offline_access'],
  clientIdMetadataDocumentEnabled:true,
  clientRegistrationEndpoint:'/oauth/register',
  // The SDK issues refresh tokens by default, independently of scope names.
  // Honor an explicit offline_access decline. Also issue a refresh token when
  // the client never requested that scope: ChatGPT follows the resource
  // challenge, which cannot list offline_access, and discovery fails without
  // a refresh token.
  tokenExchangeCallback:input=>{
    const decision=refreshGrantResult(input);
    if(decision?.reject)throw new OAuthError('invalid_grant');
    // connectorRefresh stays on the grant for later refreshes. The access
    // token presented to the resource carries only the member id.
    const userId=input?.props?.userId;
    const accessTokenProps=typeof userId==='string'?{userId}:undefined;
    if(decision)return {refreshTokenTTL:decision.refreshTokenTTL,...(accessTokenProps?{accessTokenProps}:{})};
    return accessTokenProps?{accessTokenProps}:undefined;
  }
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
