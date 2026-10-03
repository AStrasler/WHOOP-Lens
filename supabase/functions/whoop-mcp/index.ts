import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Runtime secrets come from the Supabase function environment. Do not hardcode them.
const url = Deno.env.get("SUPABASE_URL")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, service);
const encKey = Deno.env.get("WHOOP_TOKEN_ENCRYPTION_KEY")!;
const pagesApp = "https://astrasler.github.io/WHOOP-Lens/";
const whoopRedirectUri = "https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/callback";
const whoopScopes = "offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
const maxRetryWaitMs = 60_000;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "access-control-max-age": "86400",
  "content-type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const keyBytes = /^[0-9a-f]{64}$/i.test(encKey)
  ? Uint8Array.from(encKey.match(/.{2}/g)!, (h) => parseInt(h, 16))
  : new TextEncoder().encode(encKey);
const keyPromise = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);

class RateLimitError extends Error {
  constructor() {
    super("WHOOP rate limited this request. Retry later.");
    this.name = "RateLimitError";
  }
}

async function seal(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await keyPromise;
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(c)));
}

async function open(value: string) {
  const b = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const k = await keyPromise;
  const p = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, k, b.slice(12));
  return new TextDecoder().decode(p);
}

async function user(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data.user;
}

function retryAfterMs(header: string | null) {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

async function withSingleRetry(send: () => Promise<Response>) {
  let response = await send();
  if (response.status !== 429) return response;
  const delay = retryAfterMs(response.headers.get("retry-after"));
  if (delay !== null && delay <= maxRetryWaitMs) {
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delay));
    response = await send();
  }
  return response;
}

async function fetchWhoop(resource: string, token: string) {
  return withSingleRetry(() => fetch(resource, {
    headers: { authorization: "Bearer " + token },
    redirect: "error",
  }));
}

async function whoopToken(uid: string) {
  const { data } = await db.from("whoop_connections").select("*").eq("user_id", uid).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() > Date.now() + 60000) return await open(data.encrypted_access_token);
  const refresh = await open(data.encrypted_refresh_token);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: Deno.env.get("WHOOP_CLIENT_ID")!,
    client_secret: Deno.env.get("WHOOP_CLIENT_SECRET")!,
  });
  const r = await withSingleRetry(() => fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "error",
  }));
  if (r.status === 429) throw new RateLimitError();
  if (!r.ok) throw new Error("WHOOP authorization expired");
  const n = await r.json();
  if (typeof n.access_token !== "string" || !n.access_token) throw new Error("WHOOP authorization expired");
  const nextRefresh = typeof n.refresh_token === "string" && n.refresh_token
    ? await seal(n.refresh_token)
    : data.encrypted_refresh_token;
  await db.from("whoop_connections").update({
    encrypted_access_token: await seal(n.access_token),
    encrypted_refresh_token: nextRefresh,
    expires_at: new Date(Date.now() + n.expires_in * 1000).toISOString(),
    scope: n.scope ?? data.scope,
    updated_at: new Date().toISOString(),
  }).eq("user_id", uid);
  return n.access_token;
}

async function whoopAuthorizationUrl(userId: string) {
  const state = crypto.randomUUID();
  await db.from("whoop_oauth_states").insert({
    state,
    user_id: userId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  const p = new URLSearchParams({
    client_id: Deno.env.get("WHOOP_CLIENT_ID")!,
    redirect_uri: whoopRedirectUri,
    response_type: "code",
    scope: whoopScopes,
    state,
  });
  return "https://api.prod.whoop.com/oauth/oauth2/auth?" + p;
}

const base = "https://api.prod.whoop.com/developer/v2/";
const historyTools = new Set(["get_recovery", "get_sleep", "get_workouts", "get_cycles"]);

async function callTool(uid: string, name: string, args: Record<string, unknown> | undefined) {
  if (name === "get_samsung_health") {
    const metric = args?.metric;
    const allowed = ["sleep", "heart_rate", "spo2", "steps", "activity", "exercise", "body_composition", "skin_temperature", "energy_score", "blood_pressure", "profile"];
    if (metric !== undefined && (typeof metric !== "string" || !allowed.includes(metric))) throw new Error("Unknown Samsung metric");
    const limit = Math.min(100, Math.max(1, Number(args?.limit ?? 25) || 25));
    const offset = Number(args?.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("Invalid offset");
    let q = db.from("samsung_health_records").select("metric,source,transport,observed_at,exported_at,sdk_record,inserted_at")
      .eq("user_id", uid).order("inserted_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit);
    if (metric) q = q.eq("metric", metric);
    const { data, error } = await q;
    if (error) throw new Error("Samsung Health read failed");
    return {
      records: (data ?? []).slice(0, limit),
      next_offset: (data?.length ?? 0) > limit ? offset + limit : null,
      source: "samsung_health",
      transport: "samsung_health_data_sdk",
    };
  }
  const token = await whoopToken(uid);
  if (!token) throw new Error("WHOOP is not connected. Use the connect_whoop tool first.");
  const paths: Record<string, string> = {
    get_profile: "user/profile/basic",
    get_body_measurements: "user/measurement/body",
    get_recovery: "recovery",
    get_sleep: "activity/sleep",
    get_workouts: "activity/workout",
    get_cycles: "cycle",
  };
  if (!paths[name]) throw new Error("Unknown WHOOP tool");
  const history = historyTools.has(name);
  if (args?.next_token && (!history || typeof args.next_token !== "string")) throw new Error("Invalid pagination token");
  const pageSize = history && args?.auto_page ? 25 : Math.min(Math.max(Number(args?.limit ?? 10), 1), 25);
  const pagesToFetch = history && args?.auto_page ? 4 : 1;
  let cursor = typeof args?.next_token === "string" ? args.next_token : null;
  const records: unknown[] = [];
  for (let page = 0; page < pagesToFetch; page++) {
    const q = new URLSearchParams();
    if (history) q.set("limit", String(pageSize));
    else if (args?.limit) q.set("limit", String(pageSize));
    if (cursor) q.set("nextToken", cursor);
    const r = await fetchWhoop(base + paths[name] + (q.size ? "?" + q : ""), token);
    if (!r.ok) {
      if (r.status === 429) throw new RateLimitError();
      throw new Error("WHOOP request failed");
    }
    const data = await r.json();
    if (!history || !args?.auto_page) return data;
    records.push(...(data.records ?? []));
    const next = data.next_token ?? null;
    if (next && next === cursor) throw new Error("WHOOP returned a repeated pagination token");
    cursor = next;
    if (!cursor) return { records, next_token: null, complete: true, pages_fetched: page + 1 };
  }
  return { records, next_token: cursor, complete: !cursor, pages_fetched: pagesToFetch };
}

const snapshotSchema = { type: "object", properties: {}, additionalProperties: false };
const historySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 25 },
    next_token: { type: "string", minLength: 1, description: "Pagination token from this category's previous response." },
    auto_page: { type: "boolean", description: "Retrieve up to four WHOOP pages (100 records). Continue with next_token until complete is true." },
  },
  additionalProperties: false,
};
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const closed = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const toolDescriptions: Record<string, string> = {
  get_profile: "Read the signed-in user's WHOOP profile.",
  get_body_measurements: "Read the signed-in user's WHOOP body measurements.",
  get_recovery: "Read the signed-in user's WHOOP recovery history.",
  get_sleep: "Read the signed-in user's WHOOP sleep history.",
  get_workouts: "Read the signed-in user's WHOOP workout history.",
  get_cycles: "Read the signed-in user's WHOOP cycle history.",
};

function rpcError(id: unknown, code: number, message: string) {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

const instructions = "WHOOP Lens covers six WHOOP categories: recovery, sleep, cycles, workouts, body measurements, and profile. It can also read separately attributed Samsung Health records when the Android companion has uploaded them; for a broad request to understand everything, call get_samsung_health as well and state clearly if no Samsung records are uploaded. For a broad request to understand all available WHOOP data, retrieve all six; paginate each of the four history categories independently until complete is true, or state exactly which categories remain incomplete. Treat complete and next_token as internal pagination fields: never show raw status labels such as `complete: true` to the user. Describe the coverage in plain language, such as all available pages through this connection, and explain any partial retrieval. Present a concise multi-domain view in chat: recovery and HRV/resting heart rate; sleep duration, timing and stages; cycle strain and steps; workout frequency/type/strain; and body measurements/profile as snapshots. Compare dated trends and overlaps, distinguish naps and open cycles from completed days, and identify missing or nonmatching dates. For any request to explain or understand ALL WHOOP data, do not finalize after retrieving WHOOP alone. If the user has a connected ChatGPT Health source available to this conversation, call the Health connection in this request and check relevant dated records before answering; prior chat text or memory is not a substitute for a current Health lookup. Then include a Health context section covering relevant records across sleep, recovery, heart metrics, activity and body measurements. Keep Health records separate from WHOOP and never send Health details to this WHOOP server. If Health is unavailable, inaccessible, or the user declines its use, state that the WHOOP retrieval is complete but the combined Health interpretation is incomplete, with the specific reason. For narrower interpretation requests, consult Health when relevant and accessible. Separate measurements, Health context, hypotheses and unknowns; do not turn correlation or a static profile value into a cause or measured trend.";

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    const u = new URL(req.url);
    if (u.pathname.endsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: "https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp",
        authorization_servers: ["https://evoiwauqplbcecumiwqn.supabase.co/auth/v1"],
      });
    }
    if (u.pathname.endsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1",
        authorization_endpoint: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1/authorize",
        token_endpoint: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    const me = await user(req);
    if (u.pathname.endsWith("/callback")) {
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state) return json({ error: "Invalid WHOOP callback" }, 400);
      const { data: s } = await db.from("whoop_oauth_states").select("*").eq("state", state).maybeSingle();
      if (!s || new Date(s.expires_at) < new Date()) return json({ error: "Expired authorization" }, 400);
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: Deno.env.get("WHOOP_CLIENT_ID")!,
        client_secret: Deno.env.get("WHOOP_CLIENT_SECRET")!,
        redirect_uri: whoopRedirectUri,
      });
      const r = await withSingleRetry(() => fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "error",
      }));
      if (!r.ok) return json({ error: "WHOOP token exchange failed" }, 400);
      const n = await r.json();
      if (typeof n.access_token !== "string" || !n.access_token || typeof n.refresh_token !== "string" || !n.refresh_token) {
        return json({ error: "WHOOP token exchange failed" }, 400);
      }
      await db.from("whoop_connections").upsert({
        user_id: s.user_id,
        encrypted_access_token: await seal(n.access_token),
        encrypted_refresh_token: await seal(n.refresh_token),
        expires_at: new Date(Date.now() + n.expires_in * 1000).toISOString(),
        scope: n.scope ?? "",
        updated_at: new Date().toISOString(),
      });
      await db.from("whoop_oauth_states").delete().eq("state", state);
      const dest = new URL(pagesApp);
      dest.searchParams.set("connected", "1");
      try {
        const { data: account } = await db.auth.admin.getUserById(s.user_id);
        const email = account?.user?.email;
        if (typeof email === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(email) && email.length <= 254) {
          dest.searchParams.set("linked_email", email);
        }
      } catch { /* The link is already stored. Still return the visitor to the Pages app. */ }
      return new Response(null, {
        status: 302,
        headers: { location: dest.href, "cache-control": "no-store" },
      });
    }
    if (!me) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: {
          ...cors,
          "www-authenticate": 'Bearer resource_metadata="https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in to access WHOOP data"',
        },
      });
    }
    const { data: member, error: memberError } = await db.from("whoop_members").select("active").eq("user_id", me.id).maybeSingle();
    if (memberError) return json({ error: "Request failed" }, 500);
    if (member && member.active === false) return json({ error: "This account is disabled." }, 403);
    if (u.pathname.endsWith("/status")) {
      const { data: c } = await db.from("whoop_connections").select("updated_at,scope").eq("user_id", me.id).maybeSingle();
      return json({ connected: !!c, scope: c?.scope ?? "" });
    }
    if (u.pathname.endsWith("/connect")) {
      return json({ authorization_url: await whoopAuthorizationUrl(me.id) });
    }
    if (u.pathname.endsWith("/mcp")) {
      const body = await req.json().catch(() => ({}));
      if (typeof body.method === "string" && body.method.startsWith("notifications/")) return json({ jsonrpc: "2.0", result: {} });
      if (body.method === "ping") return json({ jsonrpc: "2.0", id: body.id, result: {} });
      if (body.method === "initialize") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "whoop-lens", version: "1.0.0" },
            instructions,
          },
        });
      }
      if (body.method === "tools/list") {
        const snapshots = ["get_profile", "get_body_measurements"].map((name) => ({
          name,
          description: toolDescriptions[name],
          inputSchema: snapshotSchema,
          annotations: readOnly,
        }));
        const history = ["get_recovery", "get_sleep", "get_workouts", "get_cycles"].map((name) => ({
          name,
          description: toolDescriptions[name],
          inputSchema: historySchema,
          annotations: readOnly,
        }));
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: snapshots.concat(history, [
              {
                name: "get_samsung_health",
                description: "Read Samsung Health records uploaded for the signed-in user. These records are separate from WHOOP. Paginate with offset.",
                inputSchema: {
                  type: "object",
                  properties: {
                    metric: { type: "string", enum: ["sleep", "heart_rate", "spo2", "steps", "activity", "exercise", "body_composition", "skin_temperature", "energy_score", "blood_pressure", "profile"] },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    offset: { type: "integer", minimum: 0 },
                  },
                  additionalProperties: false,
                },
                annotations: closed,
              },
              {
                name: "connect_whoop",
                description: "Return the WHOOP consent URL for the signed-in user.",
                inputSchema: { type: "object", additionalProperties: false },
                annotations: closed,
              },
            ]),
          },
        });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name;
        try {
          if (name === "connect_whoop") {
            const authorizationUrl = await whoopAuthorizationUrl(me.id);
            return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: authorizationUrl }] } });
          }
          const result = await callTool(me.id, name, body.params?.arguments ?? {});
          return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
        } catch (error) {
          if (error instanceof RateLimitError) return rpcError(body.id, -32029, "WHOOP rate limited this request. Retry later.");
          return rpcError(body.id, -32603, "The tool could not be completed.");
        }
      }
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unsupported MCP method" } }, 400);
    }
    return json({ ok: true, service: "whoop-lens" });
  } catch {
    return json({ error: "Request failed" }, 500);
  }
});
