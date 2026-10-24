import { OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { activeMembership } from "../../../src/storage.mjs";
import { createStagingRouter } from "../../../src/router.mjs";
import { WEBHOOK_PATH } from "../../../src/health-connect-webhook.mjs";
import {NOTION_CALLBACK,NOTION_START} from '../../../src/notion-oauth.mjs';

// Private MCP resource server for https://whooplens.tech/mcp.
// Cloudflare is the live MCP resource server. Do not copy legacy WHOOP refresh tokens.
const mcpResource=new OAuthResourceServer({
  resourceMetadata:{
    resource:"https://whooplens.tech/mcp",
    authorization_servers:["https://auth.whooplens.tech"],
    resource_name:"WHOOP Lens (private MCP)"
  },
  requiredScopes:["mcp:read"],
  validateToken:env=>env.AUTH_SERVER.validateToken,
  handler:{
    async fetch(request,env,ctx){
      if(env.OAUTH_RESOURCE_ENABLED!=="true"||env.MCP_ENABLED!=="true"||
         env.WHOOP_READS_ENABLED!=="true"||env.MIGRATION_API_ENABLED!=="true")
        return Response.json({error:"WHOOP Lens MCP OAuth is disabled"},{status:503});
      if(!ctx.auth.scope.includes("mcp:read"))
        return insufficientScope(ctx.auth,["mcp:read"]);
      const id=ctx.props?.userId;
      if(typeof id!=="string"||!env.DB||!await activeMembership(env.DB,id))
        return Response.json({error:"Not authorized"},{status:403});
      // Identity originates ONLY from a resource/audience-validated OAuth token,
      // never a caller-selected parameter. Existing MCP router enforces its
      // own flags and membership check in addition to the OAuth wrapper.
      return createStagingRouter({verifyIdentity:async()=>id})(request,env);
    }
  }
});

export default {
  fetch(request,env,ctx){
    // The WHOOP callback is authenticated by its expiring, atomically consumed
    // state. The Health Connect webhook authenticates its own per-user bearer.
    // All other paths retain MCP OAuth protection.
    const path=new URL(request.url).pathname;
    // Android App Links: only the debug signing certificate is registered here.
    // Release builds must add their own signing certificate fingerprint.
    if(path==='/.well-known/assetlinks.json' && request.method==='GET')
      return Response.json([{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'io.github.astrasler.whooplens',sha256_cert_fingerprints:['C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78']}}],{headers:{'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'}});
    if(path==='/android/oauth/callback' && request.method==='GET')
      return new Response('Open this link on the device with WHOOP Lens Companion installed. If it does not open automatically, enable supported links for WHOOP Lens Companion in Android settings and retry sign-in.',{status:200,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
    if(env?.OAUTH_RESOURCE_ENABLED!=="true")
      return Response.json({error:"WHOOP Lens resource server not activated"},{status:503,headers:{"cache-control":"no-store"}});
    if(path==='/api/whoop/callback'||path===WEBHOOK_PATH||path===NOTION_CALLBACK||path===NOTION_START)
      return createStagingRouter()(request,env);
    return mcpResource.fetch(request,env,ctx);
  }
};
