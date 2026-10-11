import { AccessDenied, verifySupabaseSession } from "./identity.mjs";
import { activeMembership, connectionStatus, readHistory } from "./storage.mjs";
import { callWhoop } from "./whoop-api.mjs";
import { createWhoopAuthorization, acceptWhoopCallback } from "./whoop-oauth.mjs";

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status, headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer"
    }
  });
}
export function createStagingRouter({ verifyIdentity = verifySupabaseSession, whoopRequest = callWhoop,
  whoopAuthorize = createWhoopAuthorization, whoopCallback = acceptWhoopCallback } = {}) {
  return async function stagingFetch(request, env) {
    // Deliberately disabled. This is not enabled by creating a D1 database or
    // deploying a Worker; a separately reviewed release must opt in explicitly.
    if (env?.MIGRATION_API_ENABLED !== "true")
      return json({error:"WHOOP Lens Cloudflare migration not activated"},503);

    if (request.method !== "GET")
      return json({error:"Unsupported method"},405);
    let url;
    try { url = new URL(request.url); }
    catch { return json({error:"Invalid request"},400); }
    const whoopRoutes = Object.freeze({
      "/v1/whoop/profile":"profile",
      "/v1/whoop/measurements":"measurements",
      "/v1/whoop/recovery":"recovery",
      "/v1/whoop/sleep":"sleep",
      "/v1/whoop/workouts":"workouts",
      "/v1/whoop/cycles":"cycles"
    });
    const callbackRoute = url.pathname === "/api/whoop/callback";
    const routes = new Set(["/v1/status","/v1/recovery","/v1/sleep","/v1/whoop/connect",
                            ...Object.keys(whoopRoutes)]);
    if (callbackRoute) {
      if (env?.WHOOP_OAUTH_ENABLED !== "true")
        return json({error:"WHOOP Cloudflare OAuth not activated"},503);
      if (!env?.DB) return json({error:"Staging unavailable"},503);
      try {
        const result = await whoopCallback(env.DB,url,env);
        return json(result);
      } catch {
        // Never disclose WHOOP authorization codes, states or exchanged tokens.
        return json({error:"WHOOP authorization could not be completed"},400);
      }
    }
    if (!routes.has(url.pathname)) return json({error:"Not found"},404);
    if (!env?.DB) return json({error:"Staging unavailable"},503);

    try {
      const userId = await verifyIdentity(request, env);
      const permitted = await activeMembership(env.DB, userId);
      if (!permitted) return json({error:"Not authorized for WHOOP Lens"},403);
      if (url.pathname === "/v1/whoop/connect") {
        if (env?.WHOOP_OAUTH_ENABLED !== "true")
          return json({error:"WHOOP Cloudflare OAuth not activated"},503);
        const result=await whoopAuthorize(env.DB,userId,env);
        return json(result);
      }
      if (url.pathname === "/v1/status") {
        const status = await connectionStatus(env.DB,userId);
        return json({connected:status.connected,source:"cloudflare-staging"});
      }
      const rawLimit=url.searchParams.get("limit");
      if (rawLimit != null && !/^([1-9]|1[0-9]|2[0-5])$/.test(rawLimit))
        return json({error:"Invalid limit"},400);
      if (Object.hasOwn(whoopRoutes,url.pathname)) {
        // Live WHOOP calls are gated separately from the staged D1 API.
        if (env?.WHOOP_READS_ENABLED !== "true")
          return json({error:"WHOOP Cloudflare reads not activated"},503);
        const nextToken=url.searchParams.get("next_token");
        if (nextToken != null && nextToken.length > 512)
          return json({error:"Invalid cursor"},400);
        const category=whoopRoutes[url.pathname];
        const data=await whoopRequest(env.DB,userId,category,env,{
          limit:rawLimit == null?10:Number(rawLimit),next_token:nextToken
        });
        return json({category,data,source:"whoop-cloudflare-staging"});
      }
      const category = url.pathname === "/v1/recovery" ? "recovery" : "sleep";
      const records = await readHistory(env.DB,userId,category,rawLimit == null ? 10 : Number(rawLimit));
      return json({category,records,source:"cloudflare-staging"});
    } catch (error) {
      if (error instanceof AccessDenied) return json({error:"Unauthorized"},error.status);
      // Never disclose query text, tokens, D1 errors or upstream response bodies.
      return json({error:"Staging service unavailable"},503);
    }
  };
}
