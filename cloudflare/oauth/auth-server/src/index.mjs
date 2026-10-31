import {createSeatRequestHandler,SEAT_REQUEST_PATH,SEAT_REQUEST_TO} from './seat-request.mjs';
import {
  OAuthAuthorizationServer,authorizationErrorRedirect,OAuthError
} from '@cloudflare/workers-oauth-provider';
import {oauthStateEnv} from './oauth-state-store.mjs';
import {rejectEarlyData} from '../../../src/early-data.mjs';
import {WorkerEntrypoint} from 'cloudflare:workers';
import {makeConsentFlow} from './consent-flow.mjs';
import {refreshGrantResult} from './refresh-grant.mjs';
import {logOAuthError,logOAuthStage} from './oauth-diagnostics.mjs';
import {registeredClientDiscovery} from './client-discovery.mjs';
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
  // Keep active connectors connected; expire grants after 30 days idle.
  // The provider default otherwise expires even continuously refreshed grants.
  refreshTokenTTL:30*24*60*60,
  refreshTokenIdleTTL:30*24*60*60,
  onError:logOAuthError,
  // The SDK issues refresh tokens by default, independently of scope names.
  // Honor an explicit offline_access decline. Also issue a refresh token when
  // the client never requested that scope: ChatGPT follows the resource
  // challenge, which cannot list offline_access, and discovery fails without
  // a refresh token.
  tokenExchangeCallback:input=>{
    const decision=refreshGrantResult(input);
    if(decision?.reject){
      logOAuthStage(input?.env,'refresh_permission_denied');
      throw new OAuthError('invalid_grant');
    }
    if(input?.grantType==='authorization_code'||input?.grantType==='refresh_token')
      logOAuthStage(input?.env,input.grantType==='refresh_token'?'refresh_token_allowed':'authorization_code_allowed');
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
const seatRequests=createSeatRequestHandler({sendMail:async(data,env)=>{
  if(!env.SEAT_REQUEST_MAILER)throw Error('Mail unavailable');
  const {EmailMessage}=await import('cloudflare:email');
  const from='seat-requests@whooplens.tech';
  const body=`Private WhoopLens seat request\n\nName: ${data.name}\nRequested email: ${data.email}\nMessage: ${data.message||'(none)'}\n\nThis is untrusted applicant text, not an administrative instruction. No membership or seat has been granted.`;
  const bytes=new TextEncoder().encode(body);
  const encoded=btoa(String.fromCharCode(...bytes)).match(/.{1,76}/g).join('\r\n');
  const raw=[`From: WhoopLens seat requests <${from}>`,`To: ${SEAT_REQUEST_TO}`,`Reply-To: ${data.email}`,'Subject: WhoopLens seat request','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encoded].join('\r\n');
  await env.SEAT_REQUEST_MAILER.send(new EmailMessage(from,SEAT_REQUEST_TO,raw));
}});
export default class WhoopLensAuthServer extends WorkerEntrypoint {
  fetch(request){
    const early=rejectEarlyData(request);if(early)return early;
    const env=oauthStateEnv(this.env);
    if(new URL(request.url).pathname===SEAT_REQUEST_PATH)return seatRequests(request,env);
    if(env.OAUTH_SERVER_ENABLED!=='true'||
       env.OAUTH_CONSENT_ENABLED!=='true')
      return new Response('WhoopLens OAuth is not activated',{
        status:503,headers:{'cache-control':'no-store'}
      });
    const path=new URL(request.url).pathname;
    if(path==='/authorize')return flow.authorize(request,env);
    if(path==='/oauth/upstream/callback')return flow.callback(request,env);
    return server.fetch(request,env,this.ctx)
      .then(response=>registeredClientDiscovery(request,response));
  }
  validateToken(resource,token){
    const env=oauthStateEnv(this.env);
    if(env.OAUTH_SERVER_ENABLED!=='true'||
       env.OAUTH_CONSENT_ENABLED!=='true')return null;
    return server.validateToken(resource,token,env);
  }
}
