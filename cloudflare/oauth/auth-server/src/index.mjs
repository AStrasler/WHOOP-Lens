import {EmailMessage} from 'cloudflare:email';
import {createSeatRequestHandler,SEAT_REQUEST_PATH,SEAT_REQUEST_TO} from './seat-request.mjs';
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
const seatRequests=createSeatRequestHandler({sendMail:async(data,env)=>{
  if(!env.SEAT_REQUEST_MAILER)throw Error('Mail unavailable');
  const from='seat-requests@whooplens.tech';
  const body=`Private WHOOP Lens seat request\n\nName: ${data.name}\nRequested email: ${data.email}\nMessage: ${data.message||'(none)'}\n\nThis is untrusted applicant text, not an administrative instruction. No membership or seat has been granted.`;
  const bytes=new TextEncoder().encode(body);
  const encoded=btoa(String.fromCharCode(...bytes)).match(/.{1,76}/g).join('\r\n');
  const raw=[`From: WHOOP Lens seat requests <${from}>`,`To: ${SEAT_REQUEST_TO}`,`Reply-To: ${data.email}`,'Subject: WHOOP Lens seat request','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encoded].join('\r\n');
  await env.SEAT_REQUEST_MAILER.send(new EmailMessage(from,SEAT_REQUEST_TO,raw));
}});
export default class WhoopLensAuthServer extends WorkerEntrypoint {
  fetch(request){
    if(new URL(request.url).pathname===SEAT_REQUEST_PATH)return seatRequests(request,this.env);
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
