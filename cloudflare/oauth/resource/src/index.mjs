import {rejectEarlyData} from '../../../src/early-data.mjs';
import { OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { activeMembership } from "../../../src/storage.mjs";
import { createStagingRouter } from "../../../src/router.mjs";
import { WEBHOOK_PATH } from "../../../src/health-connect-webhook.mjs";
import {healthConnectHttp} from '../../../src/health-import.mjs';
import {NOTION_CALLBACK,NOTION_START} from '../../../src/notion-oauth.mjs';
import {runRetention} from '../../../src/diagnostics.mjs';
import {WHOOP_START} from '../../../src/whoop-start.mjs';
import {SETTINGS_PATH,webSettingsPage} from '../../../src/web-settings.mjs';

// Private MCP resource server for https://whooplens.tech/mcp.
// Cloudflare is the live MCP resource server. Do not copy legacy WHOOP refresh tokens.
function createMcpResource(originalRequest){
 return new OAuthResourceServer({
  resourceMetadata:{
    resource:"https://whooplens.tech/mcp",
    authorization_servers:["https://auth.whooplens.tech"],
    resource_name:"WhoopLens (private MCP)"
  },
  requiredScopes:["mcp:read"],
  validateToken:env=>env.AUTH_SERVER.validateToken,
  handler:{
    async fetch(protectedRequest,env,ctx){
      const request=originalRequest??protectedRequest;
      if(env.OAUTH_RESOURCE_ENABLED!=="true"||env.MCP_ENABLED!=="true"||
         env.WHOOP_READS_ENABLED!=="true"||env.MIGRATION_API_ENABLED!=="true")
        return Response.json({error:"WhoopLens MCP OAuth is disabled"},{status:503});
      if(!ctx.auth.scope.includes("mcp:read"))
        return insufficientScope(ctx.auth,["mcp:read"]);
      const id=ctx.props?.userId;
      if(typeof id!=="string"||!env.DB||!await activeMembership(env.DB,id))
        return Response.json({error:"Not authorized"},{status:403});
      // Android manual Health Connect import shares the verified OAuth identity
      // and D1 membership check. It never accepts caller-supplied user IDs.
      const url=new URL(request.url);
      if(url.pathname==='/v1/health-connect/import'||url.pathname==='/v1/health-connect/status'||url.pathname==='/v1/health-connect')
        return healthConnectHttp(request,env,id);
      // Identity originates ONLY from a resource/audience-validated OAuth token,
      // never a caller-selected parameter. Existing MCP router enforces its
      // own flags and membership check in addition to the OAuth wrapper.
      return createStagingRouter({verifyIdentity:async()=>id})(request,env);
    }
  }
});
}
const mcpResource=createMcpResource();
// Exact existing API routes share the canonical MCP token audience. The original
// request is held only in this invocation's closure, never in caller headers.
const AUTHENTICATED_API_PATHS=new Set([
 '/v1/status','/v1/recovery','/v1/sleep','/v1/whoop/connect',
 '/v1/whoop/profile','/v1/whoop/measurements','/v1/whoop/recovery',
 '/v1/whoop/sleep','/v1/whoop/workouts','/v1/whoop/cycles',
 '/v1/health-connect','/v1/health-connect/import','/v1/health-connect/status',
 '/v1/health-connect/sync-status','/v1/health-connect/sync','/v1/health-connect/pause',
 '/v1/preferences/life-schedule','/v1/announcements','/v1/announcements/manage','/v1/announcements/update'
]);

const SITE_REDIRECTS={'/':'/','/privacy':'/privacy/','/privacy/':'/privacy/','/terms':'/terms/','/terms/':'/terms/','/support':'/support/','/support/':'/support/'};

export default {
  // Cron trigger (if configured): enforce diagnostic and report retention even
  // when no member is active. Deletes only rows already past retention.
  scheduled(controller,env,ctx){
    if(!env?.DB)return;
    ctx.waitUntil(runRetention(env.DB,{now:controller?.scheduledTime??Date.now()}).then(r=>{
      try{console.log(JSON.stringify({event:'retention',ok:r.ok,deleted:r.deleted}));}catch{/* log only */}
    }));
  },
  fetch(request,env,ctx){
    const early=rejectEarlyData(request);if(early)return early;
    // The WHOOP start page and callback are authenticated by the expiring,
    // atomically consumed state (and, with WHOOP_CONNECT_BROWSER_BINDING, the
    // browser cookie set by the start page). The Health Connect webhook authenticates its own per-user bearer.
    // All other paths retain MCP OAuth protection.
    const requestUrl=new URL(request.url),path=requestUrl.pathname;
    // The apex only serves the MCP resource. Public site pages live on www, so
    // the bare root and the site paths redirect there. Nothing else changes.
    if((request.method==='GET'||request.method==='HEAD')&&Object.hasOwn(SITE_REDIRECTS,path))
      return new Response(null,{status:301,headers:{location:'https://www.whooplens.tech'+SITE_REDIRECTS[path]+requestUrl.search,'cache-control':'public, max-age=3600'}});
    // Android App Links: the original companion signing certificate (Android Debug)
    // and the dedicated release key it was rotated to on Nov 1 2026 (APK v3 key
    // rotation; docs/ANDROID_RELEASES.md). Keep both until every install runs a
    // rotated build, then remove the original.
    if(path==='/.well-known/assetlinks.json' && request.method==='GET')
      return Response.json([{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'io.github.astrasler.whooplens',sha256_cert_fingerprints:['C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78','8A:A3:A7:BD:9A:CD:71:19:1D:E1:51:D6:C4:AE:4D:04:DD:3E:08:EF:57:24:E6:D1:33:A9:03:0B:36:7E:7C:80']}}],{headers:{'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'}});
    if(path==='/android/oauth/callback' && request.method==='GET')
      return new Response('Open this link on the device with WhoopLens Companion installed. If it does not open automatically, enable supported links for WhoopLens Companion in Android settings and retry sign-in.',{status:200,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
    // Website Life Schedule settings (#128). The page holds no data or secrets; it signs the
    // member in with OAuth + PKCE and calls the token-protected API on this same origin.
    if(requestUrl.origin==='https://whooplens.tech'&&(path===SETTINGS_PATH||path==='/settings'))
      return path==='/settings'?new Response(null,{status:301,headers:{location:SETTINGS_PATH,'cache-control':'no-store'}}):webSettingsPage(request,env);
    if(env?.OAUTH_RESOURCE_ENABLED!=="true")
      return Response.json({error:"WhoopLens resource server not activated"},{status:503,headers:{"cache-control":"no-store"}});
    if(path==='/api/whoop/callback'||path===WHOOP_START||path===WEBHOOK_PATH||path===NOTION_CALLBACK||path===NOTION_START)
      return createStagingRouter()(request,env);
    if(requestUrl.origin==='https://whooplens.tech' && AUTHENTICATED_API_PATHS.has(path)){
      const canonical=new URL('https://whooplens.tech/mcp');
      // OAuth validates bearer, audience, expiry and scope before the closure
      // dispatches the untouched original request, including its bounded body.
      const protectedRequest=new Request(canonical,{method:request.method,headers:request.headers});
      return createMcpResource(request).fetch(protectedRequest,env,ctx);
    }
    return mcpResource.fetch(request,env,ctx);
  }
};
