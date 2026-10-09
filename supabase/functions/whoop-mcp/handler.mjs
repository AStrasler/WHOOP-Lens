import { openaiAppsChallengeResponse } from "./challenge.mjs";

// Deploy these bytes. Live function version 40 matched this tree except an extra
// caret in the domain class ([^^\s@] versus [^\s@]). Keep this pattern.
export const LINKED_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
export const PUBLIC_SEAT_LIMIT = 9;
export const DEVELOPER_SEAT_LIMIT = 1;
export const WAITLIST_DESTINATION = "whoop-lens@outlook.com";
export const DEVELOPER_USER_ENV = "WHOOP_LENS_DEVELOPER_USER_ID";
export const WHOOP_REDIRECT_URI = "https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/callback";
export const PUBLIC_SEAT_ERROR = "WHOOP integration is limited to 9 public seats";
export const DEVELOPER_SEAT_ERROR = "WHOOP developer seat is already taken";

const pagesApp = "https://astrasler.github.io/WHOOP-Lens/";
const whoopScopes = "offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
const maxRetryWaitMs = 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "access-control-max-age": "86400",
  "content-type": "application/json",
  "cache-control": "no-store",
};
const base = "https://api.prod.whoop.com/developer/v2/";
const historyTools = new Set(["get_recovery", "get_sleep", "get_workouts", "get_cycles"]);
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
const toolDescriptions = {
  get_profile: "Read the signed-in user's WHOOP profile.",
  get_body_measurements: "Read the signed-in user's WHOOP body measurements.",
  get_recovery: "Read the signed-in user's WHOOP recovery history.",
  get_sleep: "Read the signed-in user's WHOOP sleep history.",
  get_workouts: "Read the signed-in user's WHOOP workout history.",
  get_cycles: "Read the signed-in user's WHOOP cycle history.",
};
const instructions = "WHOOP Lens covers six WHOOP categories: recovery, sleep, cycles, workouts, body measurements, and profile. It can also read separately attributed Samsung Health records when the Android companion has uploaded them; for a broad request to understand everything, call get_samsung_health as well and state clearly if no Samsung records are uploaded. For a broad request to understand all available WHOOP data, retrieve all six; paginate each of the four history categories independently until complete is true, or state exactly which categories remain incomplete. Treat complete and next_token as internal pagination fields: never show raw status labels such as `complete: true` to the user. Describe the coverage in plain language, such as all available pages through this connection, and explain any partial retrieval. Present a concise multi-domain view in chat: recovery and HRV/resting heart rate; sleep duration, timing and stages; cycle strain and steps; workout frequency/type/strain; and body measurements/profile as snapshots. Compare dated trends and overlaps, distinguish naps and open cycles from completed days, and identify missing or nonmatching dates. For any request to explain or understand ALL WHOOP data, do not finalize after retrieving WHOOP alone. If the user has a connected ChatGPT Health source available to this conversation, call the Health connection in this request and check relevant dated records before answering; prior chat text or memory is not a substitute for a current Health lookup. Then include a Health context section covering relevant records across sleep, recovery, heart metrics, activity and body measurements. Keep Health records separate from WHOOP and never send Health details to this WHOOP server. If Health is unavailable, inaccessible, or the user declines its use, state that the WHOOP retrieval is complete but the combined Health interpretation is incomplete, with the specific reason. For narrower interpretation requests, consult Health when relevant and accessible. Separate measurements, Health context, hypotheses and unknowns; do not turn correlation or a static profile value into a cause or measured trend. WHOOP Lens is read-only and cannot change WHOOP settings. When a user asks to change a WHOOP setting, goal, alarm, plan, profile value, or other configuration, clearly say that WHOOP Lens cannot make the change, direct the user to the WHOOP app, and give concise how-to steps for the relevant setting. For sleep-goal requests, use current WHOOP app guidance: on the Home screen, open Tonight's Sleep to reach Sleep Planner; for weekly sleep targets, open My Plan/View My Plan and edit the plan. If the exact in-app path is uncertain or may vary by app version, say so rather than inventing one.";
const metricEvents = new Set(["request", "seat_denied", "waitlist", "token_refresh", "whoop_retry", "tool_call", "oauth_callback"]);
const metricOutcomes = new Set([
  "ok", "denied", "error", "rate_limited", "stored", "already_listed", "not_needed", "unavailable",
  "retried", "skipped", "expired", "invalid", "seat_full", "developer_seat_taken", "disabled", "unauthenticated",
]);
const toolNames = new Set([
  "get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles",
  "get_samsung_health", "connect_whoop",
]);

export function linkedEmail(value) {
  return typeof value === "string" && value.length <= 254 && LINKED_EMAIL.test(value) ? value : null;
}

export function developerUserId(env) {
  const value = env(DEVELOPER_USER_ENV);
  return typeof value === "string" && uuidPattern.test(value) ? value.toLowerCase() : null;
}

export function evaluateSeats({ userId, connections, developerId }) {
  const rows = connections ?? [];
  const mine = rows.find((row) => row.user_id === userId);
  if (mine) {
    return { allowed: true, existing: true, seat: mine.seat_role === "developer" ? "developer" : "public" };
  }
  const developerTaken = rows.some((row) => row.seat_role === "developer");
  if (developerId && userId === developerId) {
    if (developerTaken) return { allowed: false, existing: false, seat: "developer", reason: "developer_taken" };
    return { allowed: true, existing: false, seat: "developer" };
  }
  const publicCount = rows.filter((row) => row.seat_role !== "developer").length;
  if (publicCount >= PUBLIC_SEAT_LIMIT) {
    return { allowed: false, existing: false, seat: "public", reason: "public_full" };
  }
  return { allowed: true, existing: false, seat: "public" };
}

export function seatRoleForWrite({ userId, connections, developerId }) {
  const rows = connections ?? [];
  const otherDeveloper = rows.some((row) => row.seat_role === "developer" && row.user_id !== userId);
  if (developerId && userId === developerId && !otherDeveloper) return "developer";
  const mine = rows.find((row) => row.user_id === userId);
  return mine?.seat_role === "developer" ? "developer" : "public";
}

export function retryAfterMs(header, now) {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

export function metric(log, fields) {
  try {
    const entry = {};
    entry.metric = metricEvents.has(fields.event) ? fields.event : "request";
    if (metricOutcomes.has(fields.outcome)) entry.outcome = fields.outcome;
    if (typeof fields.status === "number" && fields.status >= 100 && fields.status <= 599) entry.status = fields.status;
    if (typeof fields.duration_ms === "number" && Number.isFinite(fields.duration_ms) && fields.duration_ms >= 0 && fields.duration_ms < 600_000) {
      entry.duration_ms = Math.round(fields.duration_ms);
    }
    if (typeof fields.user_id === "string" && uuidPattern.test(fields.user_id)) entry.user_id = fields.user_id.toLowerCase();
    if (typeof fields.route === "string" && /^[a-z0-9-]{1,40}$/.test(fields.route)) entry.route = fields.route;
    if (typeof fields.tool === "string" && toolNames.has(fields.tool)) entry.tool = fields.tool;
    if (fields.seat === "public" || fields.seat === "developer") entry.seat = fields.seat;
    if (typeof fields.pages === "number" && fields.pages >= 0 && fields.pages <= 4) entry.pages = fields.pages;
    log(entry);
    return entry;
  } catch {
    return null;
  }
}

function isSeatRejection(error) {
  if (!error) return false;
  const code = String(error.code || "");
  if (code !== "P0001" && code !== "23514") return false;
  const message = String(error.message || "");
  return message.includes(PUBLIC_SEAT_ERROR) || message.includes(DEVELOPER_SEAT_ERROR);
}

export function createWhoopMcp({
  db,
  env,
  encKey,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomUUID = () => crypto.randomUUID(),
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  if (typeof encKey !== "string" || encKey.length < 16) throw new Error("WHOOP token encryption key is not configured");
  const keyBytes = /^[0-9a-f]{64}$/i.test(encKey)
    ? Uint8Array.from(encKey.match(/.{2}/g), (hex) => parseInt(hex, 16))
    : new TextEncoder().encode(encKey);
  const keyPromise = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const json = (body, status = 200, extra) => new Response(JSON.stringify(body), {
    status,
    headers: extra ? { ...cors, ...extra } : cors,
  });

  class RateLimitError extends Error {
    constructor() {
      super("WHOOP rate limited this request. Retry later.");
      this.name = "RateLimitError";
    }
  }
  class SeatFullError extends Error {
    constructor(reason, waitlist) {
      super(reason === "developer_taken" ? "The developer seat is already assigned." : "Public WHOOP seats are full.");
      this.name = "SeatFullError";
      this.reason = reason;
      this.waitlist = waitlist ?? null;
    }
  }

  async function seal(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyPromise;
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    return btoa(String.fromCharCode(...iv, ...new Uint8Array(cipher)));
  }

  async function open(value) {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const key = await keyPromise;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(plain);
  }

  async function user(req) {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const { data } = await db.auth.getUser(token);
    return data?.user ?? null;
  }

  async function withSingleRetry(send) {
    let response = await send();
    if (response.status !== 429) return response;
    const delay = retryAfterMs(response.headers.get("retry-after"), now());
    if (delay !== null && delay <= maxRetryWaitMs) {
      await response.body?.cancel().catch(() => {});
      metric(log, { event: "whoop_retry", outcome: "retried" });
      await sleep(delay);
      response = await send();
    } else {
      metric(log, { event: "whoop_retry", outcome: "skipped" });
    }
    return response;
  }

  async function fetchWhoop(resource, token) {
    return withSingleRetry(() => fetchImpl(resource, {
      headers: { authorization: "Bearer " + token },
      redirect: "error",
    }));
  }

  async function seatRows() {
    const { data, error } = await db.from("whoop_connections").select("user_id,seat_role");
    if (error) return { error };
    return { rows: data ?? [] };
  }

  async function accountEmail(userId, fallback) {
    const direct = linkedEmail(fallback);
    if (direct) return direct;
    try {
      const { data: account } = await db.auth.admin.getUserById(userId);
      return linkedEmail(account?.user?.email);
    } catch {
      return null;
    }
  }

  async function recordWaitlist(userId, email) {
    const contact = linkedEmail(email) ?? await accountEmail(userId, null);
    const { data: existing, error: readError } = await db.from("whoop_waitlist").select("user_id").eq("user_id", userId).maybeSingle();
    if (readError) return "unavailable";
    if (existing) return "already_listed";
    const { error } = await db.from("whoop_waitlist").insert({
      user_id: userId,
      contact_email: contact,
      destination: WAITLIST_DESTINATION,
    });
    if (!error) return "stored";
    if (String(error.code) === "23505") return "already_listed";
    return "unavailable";
  }

  function emitWaitlist(userId, outcome) {
    metric(log, { event: "waitlist", outcome, user_id: userId, route: "waitlist" });
  }

  async function decideSeat(userId) {
    const loaded = await seatRows();
    if (loaded.error) return { error: true };
    const developerId = developerUserId(env);
    const decision = evaluateSeats({ userId, connections: loaded.rows, developerId });
    decision.role = seatRoleForWrite({ userId, connections: loaded.rows, developerId });
    return decision;
  }

  async function assertCanConnect(userId, email) {
    const decision = await decideSeat(userId);
    if (decision.error) throw new Error("seat lookup failed");
    if (decision.allowed) return decision;
    let waitlist = null;
    if (decision.reason === "public_full") {
      waitlist = await recordWaitlist(userId, email);
      emitWaitlist(userId, waitlist);
    }
    metric(log, {
      event: "seat_denied",
      outcome: decision.reason === "developer_taken" ? "developer_seat_taken" : "seat_full",
      user_id: userId,
      seat: decision.seat,
    });
    throw new SeatFullError(decision.reason, waitlist);
  }

  function seatDeniedResponse(error) {
    if (error.reason === "developer_taken") {
      return json({ error: "The developer seat is already assigned.", code: "developer_seat_taken" }, 403);
    }
    return json({
      error: "Public WHOOP seats are full.",
      code: "seat_full",
      waitlist: error.waitlist === "stored" || error.waitlist === "already_listed" ? error.waitlist : "unavailable",
      destination: WAITLIST_DESTINATION,
    }, 403);
  }

  async function whoopToken(uid) {
    const { data } = await db.from("whoop_connections").select("*").eq("user_id", uid).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() > now() + 60000) return await open(data.encrypted_access_token);
    const refresh = await open(data.encrypted_refresh_token);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: env("WHOOP_CLIENT_ID"),
      client_secret: env("WHOOP_CLIENT_SECRET"),
    });
    const response = await withSingleRetry(() => fetchImpl("https://api.prod.whoop.com/oauth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
    }));
    if (response.status === 429) {
      metric(log, { event: "token_refresh", outcome: "rate_limited", user_id: uid });
      throw new RateLimitError();
    }
    if (!response.ok) {
      metric(log, { event: "token_refresh", outcome: "error", user_id: uid });
      throw new Error("WHOOP authorization expired");
    }
    const next = await response.json();
    if (typeof next.access_token !== "string" || !next.access_token) {
      metric(log, { event: "token_refresh", outcome: "error", user_id: uid });
      throw new Error("WHOOP authorization expired");
    }
    const nextRefresh = typeof next.refresh_token === "string" && next.refresh_token
      ? await seal(next.refresh_token)
      : data.encrypted_refresh_token;
    await db.from("whoop_connections").update({
      encrypted_access_token: await seal(next.access_token),
      encrypted_refresh_token: nextRefresh,
      expires_at: new Date(now() + next.expires_in * 1000).toISOString(),
      scope: next.scope ?? data.scope,
      updated_at: new Date(now()).toISOString(),
    }).eq("user_id", uid);
    metric(log, { event: "token_refresh", outcome: "ok", user_id: uid });
    return next.access_token;
  }

  async function whoopAuthorizationUrl(userId, email) {
    const decision = await assertCanConnect(userId, email);
    const state = randomUUID();
    await db.from("whoop_oauth_states").insert({
      state,
      user_id: userId,
      expires_at: new Date(now() + 10 * 60 * 1000).toISOString(),
    });
    const params = new URLSearchParams({
      client_id: env("WHOOP_CLIENT_ID"),
      redirect_uri: WHOOP_REDIRECT_URI,
      response_type: "code",
      scope: whoopScopes,
      state,
    });
    return { url: "https://api.prod.whoop.com/oauth/oauth2/auth?" + params, seat: decision.seat };
  }

  async function callTool(uid, name, args) {
    if (name === "get_samsung_health") {
      const metricName = args?.metric;
      const allowed = ["sleep", "heart_rate", "spo2", "steps", "activity", "exercise", "body_composition", "skin_temperature", "energy_score", "blood_pressure", "profile"];
      if (metricName !== undefined && (typeof metricName !== "string" || !allowed.includes(metricName))) throw new Error("Unknown Samsung metric");
      const limit = Math.min(100, Math.max(1, Number(args?.limit ?? 25) || 25));
      const offset = Number(args?.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("Invalid offset");
      let query = db.from("samsung_health_records").select("metric,source,transport,observed_at,exported_at,sdk_record,inserted_at")
        .eq("user_id", uid).order("inserted_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit);
      if (metricName) query = query.eq("metric", metricName);
      const { data, error } = await query;
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
    const paths = {
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
    const records = [];
    for (let page = 0; page < pagesToFetch; page++) {
      const query = new URLSearchParams();
      if (history) query.set("limit", String(pageSize));
      else if (args?.limit) query.set("limit", String(pageSize));
      if (cursor) query.set("nextToken", cursor);
      const response = await fetchWhoop(base + paths[name] + (query.size ? "?" + query : ""), token);
      if (!response.ok) {
        if (response.status === 429) throw new RateLimitError();
        throw new Error("WHOOP request failed");
      }
      const data = await response.json();
      if (!history || !args?.auto_page) return data;
      records.push(...(data.records ?? []));
      const next = data.next_token ?? null;
      if (next && next === cursor) throw new Error("WHOOP returned a repeated pagination token");
      cursor = next;
      if (!cursor) return { records, next_token: null, complete: true, pages_fetched: page + 1 };
    }
    return { records, next_token: cursor, complete: !cursor, pages_fetched: pagesToFetch };
  }

  function rpcError(id, code, message) {
    return json({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function redirect(dest) {
    return new Response(null, {
      status: 302,
      headers: { location: dest.href, "cache-control": "no-store" },
    });
  }

  async function memberActive(userId) {
    const { data: member, error } = await db.from("whoop_members").select("active").eq("user_id", userId).maybeSingle();
    if (error) return { error: true };
    if (member && member.active === false) return { active: false };
    return { active: true };
  }

  async function storeConnection(userId, tokenBody, role) {
    const written = await db.from("whoop_connections").upsert({
      user_id: userId,
      encrypted_access_token: await seal(tokenBody.access_token),
      encrypted_refresh_token: await seal(tokenBody.refresh_token),
      expires_at: new Date(now() + tokenBody.expires_in * 1000).toISOString(),
      scope: tokenBody.scope ?? "",
      seat_role: role,
      updated_at: new Date(now()).toISOString(),
    });
    return written.error ?? null;
  }

  return async function handle(req) {
    const started = now();
    let route = "unknown";
    let userId;
    try {
      if (req.method === "OPTIONS") {
        const response = new Response("ok", { headers: cors });
        metric(log, { event: "request", outcome: "ok", status: response.status, route: "options", duration_ms: now() - started });
        return response;
      }
      const url = new URL(req.url);
      route = routeName(url, req.method);
      if (req.method === "GET" && url.pathname.endsWith("/.well-known/openai-apps-challenge")) {
        const response = openaiAppsChallengeResponse(env("OPENAI_APPS_CHALLENGE"));
        metric(log, { event: "request", outcome: response.status === 200 ? "ok" : "denied", status: response.status, route, duration_ms: now() - started });
        return response;
      }
      if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
        return finish(json({
          resource: "https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp",
          authorization_servers: ["https://evoiwauqplbcecumiwqn.supabase.co/auth/v1"],
        }), { route, outcome: "ok" });
      }
      if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
        return finish(json({
          issuer: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1",
          authorization_endpoint: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1/authorize",
          token_endpoint: "https://evoiwauqplbcecumiwqn.supabase.co/auth/v1/token",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }), { route, outcome: "ok" });
      }
      const me = await user(req);
      if (url.pathname.endsWith("/callback")) {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          metric(log, { event: "oauth_callback", outcome: "invalid", route });
          return finish(json({ error: "Invalid WHOOP callback" }, 400), { route, outcome: "invalid" });
        }
        const { data: stateRow } = await db.from("whoop_oauth_states").select("*").eq("state", state).maybeSingle();
        if (!stateRow || new Date(stateRow.expires_at).getTime() < now()) {
          metric(log, { event: "oauth_callback", outcome: "expired", route });
          return finish(json({ error: "Expired authorization" }, 400), { route, outcome: "expired" });
        }
        userId = stateRow.user_id;
        const member = await memberActive(userId);
        if (member.error) return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
        if (!member.active) {
          await db.from("whoop_oauth_states").delete().eq("state", state);
          metric(log, { event: "oauth_callback", outcome: "disabled", user_id: userId });
          const dest = new URL(pagesApp);
          dest.searchParams.set("disabled", "1");
          return finish(redirect(dest), { route, outcome: "disabled", user_id: userId });
        }
        let decision;
        try {
          decision = await assertCanConnect(userId, null);
        } catch (error) {
          if (error instanceof SeatFullError) {
            await db.from("whoop_oauth_states").delete().eq("state", state);
            metric(log, { event: "oauth_callback", outcome: error.reason === "developer_taken" ? "developer_seat_taken" : "seat_full", user_id: userId });
            const dest = new URL(pagesApp);
            if (error.reason === "developer_taken") dest.searchParams.set("seat", "developer_unavailable");
            else dest.searchParams.set("waitlist", "1");
            return finish(redirect(dest), { route, outcome: "denied", user_id: userId, seat: error.reason === "developer_taken" ? "developer" : "public" });
          }
          if (error instanceof Error && error.message === "seat lookup failed") {
            return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
          }
          throw error;
        }
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: env("WHOOP_CLIENT_ID"),
          client_secret: env("WHOOP_CLIENT_SECRET"),
          redirect_uri: WHOOP_REDIRECT_URI,
        });
        const response = await withSingleRetry(() => fetchImpl("https://api.prod.whoop.com/oauth/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form,
          redirect: "error",
        }));
        if (!response.ok) {
          metric(log, { event: "oauth_callback", outcome: "error", user_id: userId });
          return finish(json({ error: "WHOOP token exchange failed" }, 400), { route, outcome: "error", user_id: userId });
        }
        const tokenBody = await response.json();
        if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token || typeof tokenBody.refresh_token !== "string" || !tokenBody.refresh_token) {
          metric(log, { event: "oauth_callback", outcome: "error", user_id: userId });
          return finish(json({ error: "WHOOP token exchange failed" }, 400), { route, outcome: "error", user_id: userId });
        }
        const writeError = await storeConnection(userId, tokenBody, decision.role);
        if (writeError) {
          if (isSeatRejection(writeError)) {
            const developerRejected = String(writeError.message || "").includes(DEVELOPER_SEAT_ERROR);
            await db.from("whoop_oauth_states").delete().eq("state", state);
            const dest = new URL(pagesApp);
            if (developerRejected) {
              metric(log, { event: "oauth_callback", outcome: "developer_seat_taken", user_id: userId });
              dest.searchParams.set("seat", "developer_unavailable");
            } else {
              const waitlist = await recordWaitlist(userId, null);
              emitWaitlist(userId, waitlist);
              metric(log, { event: "oauth_callback", outcome: "seat_full", user_id: userId });
              dest.searchParams.set("waitlist", "1");
            }
            return finish(redirect(dest), { route, outcome: "denied", user_id: userId });
          }
          return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
        }
        await db.from("whoop_oauth_states").delete().eq("state", state);
        const dest = new URL(pagesApp);
        dest.searchParams.set("connected", "1");
        try {
          const email = await accountEmail(userId, null);
          if (email) dest.searchParams.set("linked_email", email);
        } catch { /* The link is already stored. Still return the visitor to the Pages app. */ }
        metric(log, { event: "oauth_callback", outcome: "ok", user_id: userId, seat: decision.seat });
        return finish(redirect(dest), { route, outcome: "ok", user_id: userId, seat: decision.seat });
      }
      if (!me) {
        return finish(new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
          headers: {
            ...cors,
            "www-authenticate": 'Bearer resource_metadata="https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in to access WHOOP data"',
          },
        }), { route, outcome: "unauthenticated" });
      }
      userId = me.id;
      const member = await memberActive(me.id);
      if (member.error) return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
      if (!member.active) return finish(json({ error: "This account is disabled." }, 403), { route, outcome: "disabled", user_id: userId });
      if (url.pathname.endsWith("/status")) {
        const { data: connection } = await db.from("whoop_connections").select("updated_at,scope").eq("user_id", me.id).maybeSingle();
        return finish(json({ connected: !!connection, scope: connection?.scope ?? "" }), { route, outcome: "ok", user_id: userId });
      }
      if (url.pathname.endsWith("/waitlist")) {
        const decision = await decideSeat(me.id);
        if (decision.error) return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
        if (decision.allowed) {
          emitWaitlist(userId, "not_needed");
          return finish(json({ waitlist: "not_needed" }), { route, outcome: "not_needed", user_id: userId });
        }
        if (decision.reason === "developer_taken") {
          return finish(json({ error: "The developer seat is already assigned.", code: "developer_seat_taken" }, 403), { route, outcome: "developer_seat_taken", user_id: userId, seat: "developer" });
        }
        const outcome = await recordWaitlist(me.id, me.email);
        emitWaitlist(userId, outcome);
        if (outcome === "unavailable") return finish(json({ error: "Request failed", waitlist: "unavailable" }, 500), { route, outcome: "error", user_id: userId });
        return finish(json({ waitlist: outcome, destination: WAITLIST_DESTINATION }), { route, outcome, user_id: userId, seat: "public" });
      }
      if (url.pathname.endsWith("/connect")) {
        try {
          const authorization = await whoopAuthorizationUrl(me.id, me.email);
          return finish(json({ authorization_url: authorization.url }), { route, outcome: "ok", user_id: userId, seat: authorization.seat });
        } catch (error) {
          if (error instanceof SeatFullError) return finish(seatDeniedResponse(error), { route, outcome: "denied", user_id: userId, seat: error.reason === "developer_taken" ? "developer" : "public" });
          if (error instanceof Error && error.message === "seat lookup failed") {
            return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
          }
          throw error;
        }
      }
      if (url.pathname.endsWith("/mcp")) {
        const body = await req.json().catch(() => ({}));
        if (typeof body.method === "string" && body.method.startsWith("notifications/")) {
          return finish(json({ jsonrpc: "2.0", result: {} }), { route, outcome: "ok", user_id: userId });
        }
        if (body.method === "ping") return finish(json({ jsonrpc: "2.0", id: body.id, result: {} }), { route, outcome: "ok", user_id: userId });
        if (body.method === "initialize") {
          return finish(json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "whoop-lens", version: "1.0.0" },
              instructions,
            },
          }), { route, outcome: "ok", user_id: userId });
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
          return finish(json({
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
          }), { route, outcome: "ok", user_id: userId });
        }
        if (body.method === "tools/call") {
          const name = body.params?.name;
          const tool = toolNames.has(name) ? name : undefined;
          try {
            if (name === "connect_whoop") {
              const authorization = await whoopAuthorizationUrl(me.id, me.email);
              metric(log, { event: "tool_call", outcome: "ok", user_id: userId, tool: "connect_whoop" });
              return finish(json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: authorization.url }] } }), { route, outcome: "ok", user_id: userId, tool: "connect_whoop" });
            }
            const result = await callTool(me.id, name, body.params?.arguments ?? {});
            metric(log, { event: "tool_call", outcome: "ok", user_id: userId, tool, pages: result?.pages_fetched });
            return finish(json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }), { route, outcome: "ok", user_id: userId, tool });
          } catch (error) {
            if (error instanceof RateLimitError) {
              metric(log, { event: "tool_call", outcome: "rate_limited", user_id: userId, tool });
              return finish(rpcError(body.id, -32029, "WHOOP rate limited this request. Retry later."), { route, outcome: "rate_limited", user_id: userId, tool });
            }
            if (error instanceof SeatFullError) {
              const message = error.reason === "developer_taken"
                ? "The developer seat is already assigned."
                : "Public WHOOP seats are full. This account was not connected and is on the waitlist.";
              metric(log, { event: "tool_call", outcome: "denied", user_id: userId, tool: "connect_whoop" });
              return finish(rpcError(body.id, -32009, message), { route, outcome: "denied", user_id: userId, tool: "connect_whoop" });
            }
            metric(log, { event: "tool_call", outcome: "error", user_id: userId, tool });
            return finish(rpcError(body.id, -32603, "The tool could not be completed."), { route, outcome: "error", user_id: userId, tool });
          }
        }
        return finish(json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unsupported MCP method" } }, 400), { route, outcome: "error", user_id: userId });
      }
      return finish(json({ ok: true, service: "whoop-lens" }), { route, outcome: "ok", user_id: userId });
    } catch {
      return finish(json({ error: "Request failed" }, 500), { route, outcome: "error", user_id: userId });
    }

    function finish(response, fields) {
      metric(log, {
        event: "request",
        outcome: fields.outcome,
        status: response.status,
        route: fields.route ?? route,
        duration_ms: now() - started,
        user_id: fields.user_id,
        seat: fields.seat,
        tool: fields.tool,
      });
      return response;
    }
  };
}

function routeName(url, method) {
  if (method === "OPTIONS") return "options";
  const path = url.pathname;
  if (method === "GET" && path.endsWith("/.well-known/openai-apps-challenge")) return "challenge";
  if (path.endsWith("/.well-known/oauth-protected-resource")) return "oauth-protected-resource";
  if (path.endsWith("/.well-known/oauth-authorization-server")) return "oauth-authorization-server";
  if (path.endsWith("/callback")) return "callback";
  if (path.endsWith("/status")) return "status";
  if (path.endsWith("/connect")) return "connect";
  if (path.endsWith("/waitlist")) return "waitlist";
  if (path.endsWith("/mcp")) return "mcp";
  return "root";
}
