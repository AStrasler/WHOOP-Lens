import { AuthorizationError, OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { consentPreview, unavailable } from "../../consent.mjs";

// Official Cloudflare OAuth 2.1 engine, kept wholly separate from Supabase.
// Registration, PKCE, resource audiences, hashed tokens and revocation are
// handled by the library. Application sign-in and consent ARE NOT IMPLEMENTED.
export const ISSUER="https://auth.whooplens.tech";
export const RESOURCE="https://whooplens.tech/mcp";
const server=new OAuthAuthorizationServer({
  issuer:ISSUER,
  resources:[RESOURCE],
  scopesSupported:["mcp:read","offline_access"],
  clientIdMetadataDocumentEnabled:true,
  clientRegistrationEndpoint:"/oauth/register"
});

async function authorizationPreview(request,env) {
  if(request.method!=="GET")return unavailable();
  const oauth=server.getOAuthApi(env);
  try {
    // Validates client ID, exact redirect URI, S256 PKCE, scope and resource.
    const parsed=await oauth.parseAuthRequest(request);
    const details=await oauth.describeConsent(parsed);
    // No beginConsent()/completeAuthorization() until there is a secure
    // account sign-in and explicit owner-approved consent implementation.
    return new Response(consentPreview(details),{
      status:503,headers:{
        "content-type":"text/html; charset=utf-8",
        "cache-control":"no-store",
        "content-security-policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "x-frame-options":"DENY",
        "referrer-policy":"no-referrer",
        "x-content-type-options":"nosniff"
      }
    });
  }catch(error) {
    if(error instanceof AuthorizationError) {
      // With a consent flow disabled, NEVER redirect even on a validated
      // OAuth error. Keep the entire auth server private until owner approval.
      return new Response("The WHOOP Lens authorization request is unavailable.",{
        status:400,headers:{"cache-control":"no-store","content-type":"text/plain; charset=utf-8"}
      });
    }
    return unavailable();
  }
}
export default class WhoopLensAuthServer extends WorkerEntrypoint {
  fetch(request) {
    if(this.env.OAUTH_SERVER_ENABLED!=="true")return unavailable();
    const pathname=new URL(request.url).pathname;
    if(pathname==="/authorize")return authorizationPreview(request,this.env);
    // This serves metadata/PKCE/token/revocation/client-registration only
    // when explicitly enabled, which it is NOT in staging configuration.
    return server.fetch(request,this.env,this.ctx);
  }
  validateToken(resource,token) {
    if(this.env.OAUTH_SERVER_ENABLED!=="true")return null;
    return server.validateToken(resource,token,this.env);
  }
}
