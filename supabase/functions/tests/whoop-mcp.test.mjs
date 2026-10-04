import assert from "node:assert/strict";
import test from "node:test";
import {
  LINKED_EMAIL,
  PUBLIC_SEAT_LIMIT,
  WAITLIST_DESTINATION,
  WHOOP_REDIRECT_URI,
  createWhoopMcp,
  evaluateSeats,
  linkedEmail,
  metric,
  retryAfterMs,
} from "../whoop-mcp/handler.mjs";

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const developer = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const encKey = "test-only-encryption-key";
const secretMarkers = [
  "test-client-secret",
  "oauth-code-do-not-log",
  "access-do-not-log",
  "refresh-do-not-log",
  "health-payload-marker",
  "session-do-not-log",
  "Bearer ",
  "a@b^c.com",
  "b@example.com",
];

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function createMemoryDb(initial = {}) {
  const tables = {
    whoop_connections: clone(initial.whoop_connections ?? []),
    whoop_oauth_states: clone(initial.whoop_oauth_states ?? []),
    whoop_members: clone(initial.whoop_members ?? []),
    whoop_waitlist: clone(initial.whoop_waitlist ?? []),
    samsung_health_records: clone(initial.samsung_health_records ?? []),
  };
  let upsertError = null;
  function from(name) {
    if (!Object.hasOwn(tables, name)) throw new Error("Unknown table " + name);
    const filters = [];
    const orders = [];
    let range = null;
    let operation = "select";
    let payload = null;
    const query = {
      select() { return query; },
      insert(row) { operation = "insert"; payload = row; return query; },
      update(row) { operation = "update"; payload = row; return query; },
      upsert(row) { operation = "upsert"; payload = row; return query; },
      delete() { operation = "delete"; return query; },
      eq(column, value) { filters.push({ op: "eq", column, value }); return query; },
      neq(column, value) { filters.push({ op: "neq", column, value }); return query; },
      order(column, options = {}) { orders.push({ column, ascending: options.ascending !== false }); return query; },
      range(start, end) { range = [start, end]; return query; },
      maybeSingle() { return exec(true); },
      then(resolve, reject) { return exec(false).then(resolve, reject); },
    };
    function matches(row) {
      return filters.every((filter) => filter.op === "eq" ? row[filter.column] === filter.value : row[filter.column] !== filter.value);
    }
    function exec(single) {
      const rows = tables[name];
      if (operation === "insert") {
        const copy = clone(payload);
        rows.push(copy);
        return Promise.resolve({ data: single ? copy : [copy], error: null });
      }
      if (operation === "upsert") {
        if (upsertError) {
          const error = upsertError;
          upsertError = null;
          return Promise.resolve({ data: null, error });
        }
        const copy = clone(payload);
        const index = rows.findIndex((row) => row.user_id === copy.user_id);
        if (index === -1) rows.push(copy);
        else rows[index] = { ...rows[index], ...copy };
        return Promise.resolve({ data: null, error: null });
      }
      if (operation === "update") {
        for (const row of rows) if (matches(row)) Object.assign(row, clone(payload));
        return Promise.resolve({ data: null, error: null });
      }
      if (operation === "delete") {
        tables[name] = rows.filter((row) => !matches(row));
        return Promise.resolve({ data: null, error: null });
      }
      let selected = rows.filter(matches);
      if (orders.length) {
        selected = selected.slice().sort((left, right) => {
          for (const order of orders) {
            if (left[order.column] === right[order.column]) continue;
            const compared = left[order.column] > right[order.column] ? 1 : -1;
            return order.ascending ? compared : -compared;
          }
          return 0;
        });
      }
      if (range) selected = selected.slice(range[0], range[1] + 1);
      if (single) return Promise.resolve({ data: selected[0] ? clone(selected[0]) : null, error: null });
      return Promise.resolve({ data: selected.map(clone), error: null });
    }
    return query;
  }
  return {
    from,
    tables,
    failNextUpsert(error) { upsertError = error; },
  };
}

function createHarness(options = {}) {
  const memory = createMemoryDb(options.rows);
  const users = new Map([
    ["session-do-not-log-a", { id: userA, email: "a@b^c.com" }],
    ["session-do-not-log-b", { id: userB, email: "b@example.com" }],
    ["session-do-not-log-dev", { id: developer, email: "dev@example.com" }],
  ]);
  for (const [token, user] of options.users ?? []) users.set(token, user);
  const byId = new Map([...users.values()].map((user) => [user.id, user]));
  const fetches = [];
  const logs = [];
  const env = {
    WHOOP_CLIENT_ID: "test-client-id",
    WHOOP_CLIENT_SECRET: "test-client-secret",
    OPENAI_APPS_CHALLENGE: "challenge-token",
    ...options.env,
  };
  let clock = options.now ?? 1_700_000_000_000;
  const db = {
    from: memory.from,
    auth: {
      async getUser(token) {
        return { data: { user: users.get(token) ?? null }, error: null };
      },
      admin: {
        async getUserById(id) {
          return { data: { user: byId.get(id) ?? null }, error: null };
        },
      },
    },
  };
  const handle = createWhoopMcp({
    db,
    encKey,
    env: (name) => env[name],
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), init });
      return options.fetch(url, init, fetches);
    },
    now: () => clock,
    sleep: async () => { options.sleeps = (options.sleeps ?? 0) + 1; },
    randomUUID: options.randomUUID ?? (() => "11111111-1111-4111-8111-111111111111"),
    log: (entry) => logs.push(entry),
  });
  return {
    handle,
    db,
    memory,
    logs,
    fetches,
    env,
    setNow(value) { clock = value; },
    now: () => clock,
  };
}

function request(path, { method = "GET", token, body, search = "" } = {}) {
  return new Request("https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp" + path + search, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assertSafe(logs, extra = []) {
  const text = JSON.stringify(logs);
  for (const marker of secretMarkers.concat(extra)) assert.equal(text.includes(marker), false, marker);
}

function tokenFetch(url) {
  return String(url).includes("/oauth/oauth2/token");
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function issuedTokens(label) {
  return {
    access_token: "access-do-not-log-" + label,
    refresh_token: "refresh-do-not-log-" + label,
    expires_in: 3600,
    scope: "offline read:profile",
  };
}

test("linked email accepts a normal address and a caret in the domain", () => {
  assert.equal(linkedEmail("user@example.com"), "user@example.com");
  assert.equal(linkedEmail("a@b^c.com"), "a@b^c.com");
  assert.equal(LINKED_EMAIL.test("a@b^c.com"), true);
  assert.equal(linkedEmail("not an email"), null);
  assert.equal(linkedEmail("a@b.c"), null);
});

test("retry-after accepts seconds and dates inside the one minute budget", () => {
  const now = Date.parse("2026-10-04T00:00:00.000Z");
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs("0", now), 0);
  assert.equal(retryAfterMs("1.5", now), 1500);
  assert.equal(retryAfterMs("nope", now), null);
  assert.equal(retryAfterMs("Sun, 04 Oct 2026 00:00:01 GMT", now), 1000);
  assert.equal(retryAfterMs("Sat, 03 Oct 2026 00:00:00 GMT", now), 0);
});

test("metrics keep an allowlist and drop tokens, headers, codes, and health fields", () => {
  const entries = [];
  const entry = metric((value) => entries.push(value), {
    event: "token_refresh",
    outcome: "ok",
    status: 200,
    user_id: userA,
    route: "callback",
    authorization: "Bearer session-do-not-log",
    access_token: "access-do-not-log",
    refresh_token: "refresh-do-not-log",
    code: "oauth-code-do-not-log",
    email: "a@b^c.com",
    body: { hrv: 12, marker: "health-payload-marker" },
    pages: 2,
  });
  assert.deepEqual(entry, {
    metric: "token_refresh",
    outcome: "ok",
    status: 200,
    user_id: userA,
    route: "callback",
    pages: 2,
  });
  assertSafe(entries);
});

test("seat math is 9 public seats plus one developer seat", () => {
  const connections = Array.from({ length: PUBLIC_SEAT_LIMIT }, (_, index) => ({
    user_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    seat_role: "public",
  }));
  assert.equal(evaluateSeats({ userId: userB, connections, developerId: developer }).allowed, false);
  assert.equal(evaluateSeats({ userId: developer, connections, developerId: developer }).seat, "developer");
  assert.equal(evaluateSeats({ userId: developer, connections, developerId: null }).allowed, false);
  assert.equal(evaluateSeats({ userId: connections[0].user_id, connections, developerId: developer }).existing, true);
  const withDeveloper = connections.concat([{ user_id: developer, seat_role: "developer" }]);
  assert.equal(evaluateSeats({ userId: userB, connections: withDeveloper, developerId: developer }).reason, "public_full");
  assert.equal(evaluateSeats({ userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", connections: withDeveloper, developerId: developer }).allowed, false);
});

test("a disabled account cannot finish the WHOOP callback", async () => {
  let called = false;
  const harness = createHarness({
    rows: {
      whoop_members: [{ user_id: userA, active: false }],
      whoop_oauth_states: [{ state: "disabled-state", user_id: userA, expires_at: new Date(2_000_000_000_000).toISOString() }],
    },
    fetch: async () => { called = true; return jsonResponse(issuedTokens("a")); },
  });
  const response = await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=disabled-state" }));
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("disabled"), "1");
  assert.equal(called, false);
  assert.equal(harness.memory.tables.whoop_connections.length, 0);
  assert.equal(harness.memory.tables.whoop_oauth_states.length, 0);
  assertSafe(harness.logs);
});

test("auth rejects missing and unknown sessions and allows a disabled check to win", async () => {
  const harness = createHarness({ fetch: async () => jsonResponse({}) });
  const missing = await harness.handle(request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } }));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /oauth-protected-resource/);
  assert.equal((await missing.json()).error, "Authentication required");
  const unknown = await harness.handle(request("/status", { token: "not-a-session" }));
  assert.equal(unknown.status, 401);
  harness.memory.tables.whoop_members.push({ user_id: userA, active: false });
  const disabled = await harness.handle(request("/status", { token: "session-do-not-log-a" }));
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error, "This account is disabled.");
  assert.equal(harness.memory.tables.whoop_waitlist.length, 0);
  assertSafe(harness.logs);
});

test("challenge route returns the env value as text or 404 when it is unset", async () => {
  const harness = createHarness({ fetch: async () => jsonResponse({}) });
  const found = await harness.handle(request("/.well-known/openai-apps-challenge"));
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("content-type"), "text/plain");
  assert.equal(await found.text(), "challenge-token");
  delete harness.env.OPENAI_APPS_CHALLENGE;
  const missing = await harness.handle(request("/prefix/.well-known/openai-apps-challenge"));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/plain");
  assert.equal(await missing.text(), "");
  const posted = await harness.handle(request("/.well-known/openai-apps-challenge", { method: "POST", body: {} }));
  assert.equal(posted.status, 401);
  assert.equal((await posted.text()).includes("challenge-token"), false);
  const metadata = await harness.handle(request("/.well-known/oauth-protected-resource"));
  assert.equal(metadata.status, 200);
  assertSafe(harness.logs);
});

test("oauth state is bound to the signed-in user and expires", async () => {
  const harness = createHarness({
    fetch: async () => jsonResponse(issuedTokens("a")),
  });
  const connect = await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  const connected = await connect.json();
  const authorization = new URL(connected.authorization_url);
  assert.equal(authorization.origin, "https://api.prod.whoop.com");
  assert.equal(authorization.pathname, "/oauth/oauth2/auth");
  assert.equal(authorization.searchParams.get("redirect_uri"), WHOOP_REDIRECT_URI);
  assert.equal(authorization.searchParams.get("client_id"), "test-client-id");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("scope"), "offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles");
  assert.equal(authorization.searchParams.get("state"), "11111111-1111-4111-8111-111111111111");
  assert.equal(connected.authorization_url.includes("test-client-secret"), false);
  assert.equal(harness.memory.tables.whoop_oauth_states[0].user_id, userA);
  assert.equal(Date.parse(harness.memory.tables.whoop_oauth_states[0].expires_at) - harness.now(), 10 * 60 * 1000);

  const missing = await harness.handle(request("/callback", { search: "?state=11111111-1111-4111-8111-111111111111" }));
  assert.equal(missing.status, 400);
  assert.equal(harness.fetches.filter((call) => tokenFetch(call.url)).length, 0);

  harness.setNow(harness.now() + 10 * 60 * 1000 + 1);
  const expired = await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, "Expired authorization");
  assert.equal(harness.fetches.length, 0);
  assertSafe(harness.logs);
});

test("callback stores only the state owner's tokens and keeps a caret address", async () => {
  const harness = createHarness({
    fetch: async () => jsonResponse(issuedTokens("a")),
  });
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  const callback = await harness.handle(request("/callback", {
    token: "session-do-not-log-b",
    search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111",
  }));
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location"));
  assert.equal(location.searchParams.get("connected"), "1");
  assert.equal(location.searchParams.get("linked_email"), "a@b^c.com");
  assert.equal(location.href.includes("oauth-code-do-not-log"), false);
  assert.equal(harness.memory.tables.whoop_oauth_states.length, 0);
  assert.equal(harness.memory.tables.whoop_connections.length, 1);
  assert.equal(harness.memory.tables.whoop_connections[0].user_id, userA);
  assert.equal(harness.memory.tables.whoop_connections[0].seat_role, "public");
  assert.equal(JSON.stringify(harness.memory.tables.whoop_connections[0]).includes("oauth-code-do-not-log"), false);
  const replay = await harness.handle(request("/callback", {
    search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111",
  }));
  assert.equal(replay.status, 400);
  const statusB = await harness.handle(request("/status", { token: "session-do-not-log-b" }));
  assert.deepEqual(await statusB.json(), { connected: false, scope: "" });
  const statusA = await harness.handle(request("/status", { token: "session-do-not-log-a" }));
  const statusBody = await statusA.json();
  assert.equal(statusBody.connected, true);
  assert.equal(JSON.stringify(statusBody).includes("access-do-not-log"), false);
  assertSafe(harness.logs);
});

test("token refresh updates only the caller and retries one 429", async () => {
  let refreshCalls = 0;
  const harness = createHarness({
    fetch: async (url, init) => {
      if (tokenFetch(url) && init?.body && String(init.body).includes("grant_type=authorization_code")) return jsonResponse(issuedTokens("b"));
      refreshCalls += 1;
      if (refreshCalls === 1) return jsonResponse({ marker: "health-payload-marker" }, 429, { "retry-after": "0" });
      return jsonResponse({ access_token: "access-do-not-log-b2", expires_in: 3600, scope: "offline read:sleep" });
    },
  });
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-b", body: {} }));
  await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  const beforeA = "sealed-a-stays";
  harness.memory.tables.whoop_connections.push({
    user_id: userA,
    seat_role: "public",
    scope: "offline read:profile",
    expires_at: new Date(harness.now() - 1000).toISOString(),
    encrypted_access_token: beforeA,
    encrypted_refresh_token: "refresh-sealed-a",
  });
  const own = harness.memory.tables.whoop_connections.find((row) => row.user_id === userB);
  const oldRefresh = own.encrypted_refresh_token;
  const oldAccess = own.encrypted_access_token;
  own.expires_at = new Date(harness.now() - 1000).toISOString();
  const profile = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_profile", arguments: { user_id: userA } } },
  }));
  const body = await profile.json();
  assert.equal(body.error, undefined);
  const refresh = harness.fetches.filter((call) => tokenFetch(call.url) && String(call.init?.body).includes("grant_type=refresh_token"));
  assert.equal(refresh.length, 2);
  assert.equal(String(refresh[0].init.body).includes("refresh-do-not-log-b"), true);
  assert.equal(String(refresh[0].init.body).includes("refresh-do-not-log-a"), false);
  assert.equal(String(refresh[0].init.body).includes("test-client-secret"), true);
  const updated = harness.memory.tables.whoop_connections.find((row) => row.user_id === userB);
  assert.equal(updated.encrypted_refresh_token, oldRefresh);
  assert.notEqual(updated.encrypted_access_token, oldAccess);
  const untouched = harness.memory.tables.whoop_connections.find((row) => row.user_id === userA);
  assert.equal(untouched.encrypted_access_token, beforeA);
  assert.equal(untouched.encrypted_refresh_token, "refresh-sealed-a");
  assert.equal(JSON.stringify(body).includes("health-payload-marker"), false);
  assert.equal(harness.logs.some((entry) => entry.metric === "whoop_retry" && entry.outcome === "retried"), true);
  assert.equal(harness.logs.some((entry) => entry.metric === "token_refresh" && entry.outcome === "ok" && entry.user_id === userB), true);
  assertSafe(harness.logs);
});

test("a long retry-after is not slept and the health body is not returned", async () => {
  const harness = createHarness({
    fetch: async (url) => {
      if (tokenFetch(url)) return jsonResponse({ marker: "health-payload-marker", access_token: "access-do-not-log" }, 429, { "retry-after": "61" });
      return jsonResponse({});
    },
  });
  harness.memory.tables.whoop_connections.push({
    user_id: userB,
    seat_role: "public",
    scope: "offline",
    expires_at: new Date(0).toISOString(),
    encrypted_access_token: "unused",
    encrypted_refresh_token: "also-unused",
  });
  // The stored cipher is not a real seal, so this path is only for the 429 branch after a real refresh.
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  const callback = await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  assert.equal(callback.status, 400);
  assert.equal(harness.fetches.length, 1);
  assert.equal(harness.logs.some((entry) => entry.metric === "whoop_retry" && entry.outcome === "skipped"), true);
  assert.equal(JSON.stringify(harness.logs).includes("health-payload-marker"), false);
  assertSafe(harness.logs);
});

test("pagination stays on the caller token and stops on a repeated cursor", async () => {
  let page = 0;
  const harness = createHarness({
    fetch: async (url, init) => {
      if (tokenFetch(url)) return jsonResponse(issuedTokens("b"));
      page += 1;
      assert.equal(init.headers.authorization, "Bearer access-do-not-log-b");
      const cursor = new URL(url).searchParams.get("nextToken");
      if (cursor === "loop") return jsonResponse({ records: [{ marker: "health-payload-marker" }], next_token: "loop" });
      if (!cursor) return jsonResponse({ records: [{ id: "p1" }], next_token: "t2" });
      if (cursor === "t2") return jsonResponse({ records: [{ id: "p2" }], next_token: null });
      return jsonResponse({ records: [{ id: "extra" }], next_token: "more" });
    },
  });
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-b", body: {} }));
  await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  const listed = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  }));
  const tools = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_samsung_health", "connect_whoop"]);
  const paged = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_sleep", arguments: { auto_page: true, next_token: "not-used-yet" } } },
  }));
  // The first call passes the supplied cursor, so restart from a fresh cursor below.
  assert.equal(paged.status, 200);
  const fresh = createHarness({
    fetch: async (url, init) => {
      if (tokenFetch(url)) return jsonResponse(issuedTokens("b"));
      assert.equal(init.headers.authorization, "Bearer access-do-not-log-b");
      const cursor = new URL(url).searchParams.get("nextToken");
      if (cursor === "loop") return jsonResponse({ records: [{ marker: "health-payload-marker" }], next_token: "loop" });
      if (!cursor) return jsonResponse({ records: [{ id: "p1" }], next_token: "t2" });
      if (cursor === "t2") return jsonResponse({ records: [{ id: "p2" }], next_token: null });
      return jsonResponse({ records: [], next_token: null });
    },
  });
  await fresh.handle(request("/connect", { method: "POST", token: "session-do-not-log-b", body: {} }));
  await fresh.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  const sleep = await fresh.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_sleep", arguments: { auto_page: true } } },
  }));
  const sleepBody = JSON.parse((await sleep.json()).result.content[0].text);
  assert.deepEqual(sleepBody.records, [{ id: "p1" }, { id: "p2" }]);
  assert.equal(sleepBody.complete, true);
  assert.equal(sleepBody.pages_fetched, 2);
  const repeated = await fresh.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_recovery", arguments: { auto_page: true, next_token: "loop" } } },
  }));
  const repeatedBody = await repeated.json();
  assert.equal(repeatedBody.error.code, -32603);
  assert.equal(repeatedBody.error.message, "The tool could not be completed.");
  assert.equal(JSON.stringify(repeatedBody).includes("health-payload-marker"), false);
  assert.equal(JSON.stringify(repeatedBody).includes("loop"), false);
  const snapshot = await fresh.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_profile", arguments: { next_token: "nope" } } },
  }));
  assert.equal((await snapshot.json()).error.code, -32603);
  assertSafe(fresh.logs);
  assertSafe(harness.logs);
});

test("mcp methods, four-page cap, and a data 429 stay generic", async () => {
  let pages = 0;
  const harness = createHarness({
    fetch: async (url, init) => {
      if (tokenFetch(url)) return jsonResponse(issuedTokens("a"));
      pages += 1;
      if (pages > 4) return jsonResponse({ records: [{ marker: "health-payload-marker" }], next_token: "overflow" });
      assert.equal(init.headers.authorization, "Bearer access-do-not-log-a");
      return jsonResponse({ records: [{ id: "page-" + pages }], next_token: "cursor-" + pages });
    },
  });
  const unauthenticated = await harness.handle(request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize" } }));
  assert.equal(unauthenticated.status, 401);
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  const initialized = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 2, method: "initialize" },
  }));
  assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
  const ping = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 3, method: "ping" },
  }));
  assert.deepEqual((await ping.json()).result, {});
  const note = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  }));
  assert.deepEqual((await note.json()).result, {});
  const unsupported = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 4, method: "prompts/list" },
  }));
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, -32601);
  const capped = await harness.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_cycles", arguments: { auto_page: true } } },
  }));
  const cappedBody = JSON.parse((await capped.json()).result.content[0].text);
  assert.equal(cappedBody.pages_fetched, 4);
  assert.equal(cappedBody.complete, false);
  assert.equal(cappedBody.next_token, "cursor-4");
  assert.equal(pages, 4);
  pages = 100;
  const limited = createHarness({
    fetch: async (url) => {
      if (tokenFetch(url)) return jsonResponse(issuedTokens("a"));
      return jsonResponse({ marker: "health-payload-marker" }, 429, { "retry-after": "0" });
    },
  });
  await limited.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  await limited.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  const denied = await limited.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_workouts", arguments: {} } },
  }));
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, -32029);
  assert.equal(deniedBody.error.message, "WHOOP rate limited this request. Retry later.");
  assert.equal(JSON.stringify(deniedBody).includes("health-payload-marker"), false);
  assertSafe(limited.logs, ["cursor-4"]);
  assertSafe(harness.logs, ["cursor-1", "cursor-2", "cursor-3", "cursor-4"]);
});

test("a second user cannot read the first user's connection, tokens, or health rows", async () => {
  const harness = createHarness({
    rows: {
      samsung_health_records: [
        { id: "a-row", user_id: userA, metric: "sleep", source: "samsung_health", transport: "samsung_health_data_sdk", sdk_record: { marker: "health-a" }, inserted_at: "2026-01-02T00:00:00.000Z", observed_at: null, exported_at: "2026-01-02T00:00:00.000Z" },
        { id: "b-new", user_id: userB, metric: "sleep", source: "samsung_health", transport: "samsung_health_data_sdk", sdk_record: { marker: "health-b" }, inserted_at: "2026-01-03T00:00:00.000Z", observed_at: null, exported_at: "2026-01-03T00:00:00.000Z" },
        { id: "b-old", user_id: userB, metric: "steps", source: "samsung_health", transport: "samsung_health_data_sdk", sdk_record: { marker: "health-b-old" }, inserted_at: "2026-01-01T00:00:00.000Z", observed_at: null, exported_at: "2026-01-01T00:00:00.000Z" },
      ],
    },
    fetch: async (url, init) => {
      if (tokenFetch(url)) {
        const codeOwner = String(init?.body).includes("oauth-code-do-not-log-a") ? "a" : "b";
        return jsonResponse(issuedTokens(codeOwner));
      }
      assert.equal(init.headers.authorization, "Bearer access-do-not-log-b");
      if (String(url).includes("nextToken=from-a")) return jsonResponse({ records: [{ marker: "health-payload-marker", owner: "should-not-switch" }], next_token: null });
      return jsonResponse({ records: [{ id: "b-sleep", marker: "health-b-whoop" }], next_token: null });
    },
  });
  await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log-a&state=11111111-1111-4111-8111-111111111111" }));
  const harnessB = createHarness({
    rows: { whoop_connections: harness.memory.tables.whoop_connections, samsung_health_records: harness.memory.tables.samsung_health_records, whoop_oauth_states: [], whoop_members: [], whoop_waitlist: [] },
    fetch: async (url, init) => {
      if (tokenFetch(url)) return jsonResponse(issuedTokens("b"));
      assert.equal(init.headers.authorization, "Bearer access-do-not-log-b");
      const cursor = new URL(url).searchParams.get("nextToken");
      if (cursor === "from-a") return jsonResponse({ records: [{ id: "still-b" }], next_token: null });
      return jsonResponse({ records: [{ id: "b-page", marker: "health-b-whoop" }], next_token: "from-a" });
    },
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
  });
  // Share the connection table so A's sealed tokens remain visible to a buggy unfiltered query.
  harnessB.memory.tables.whoop_connections = harness.memory.tables.whoop_connections;
  await harnessB.handle(request("/connect", { method: "POST", token: "session-do-not-log-b", body: {} }));
  await harnessB.handle(request("/callback", { search: "?code=oauth-code-do-not-log-b&state=22222222-2222-4222-8222-222222222222" }));
  const status = await harnessB.handle(request("/status", { token: "session-do-not-log-b" }));
  const statusBody = await status.json();
  assert.equal(statusBody.connected, true);
  assert.equal(statusBody.scope.includes("read:profile"), true);
  assert.equal(JSON.stringify(statusBody).includes("access-do-not-log-a"), false);
  const samsung = await harnessB.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_samsung_health", arguments: { limit: 1, offset: 0, user_id: userA } } },
  }));
  const samsungBody = JSON.parse((await samsung.json()).result.content[0].text);
  assert.deepEqual(samsungBody.records.map((row) => row.id), ["b-new"]);
  assert.equal(samsungBody.next_offset, 1);
  assert.equal(JSON.stringify(samsungBody).includes("health-a"), false);
  const page = await harnessB.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_sleep", arguments: { next_token: "from-a", user_id: userA } } },
  }));
  const pageBody = JSON.parse((await page.json()).result.content[0].text);
  assert.equal(pageBody.records[0].id, "still-b");
  assert.equal(JSON.stringify(pageBody).includes("health-payload-marker"), false);
  const failed = await harnessB.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_profile", arguments: {} } },
  }));
  // get_profile has no next token; the fetch mock returns B's page. Force an upstream failure next.
  assert.equal(failed.error, undefined);
  const broken = createHarness({
    rows: { whoop_connections: harnessB.memory.tables.whoop_connections.map((row) => ({ ...row })) },
    fetch: async (url) => {
      if (tokenFetch(url)) return jsonResponse({ access_token: "access-do-not-log-b" });
      return jsonResponse({ access_token: "access-do-not-log-a", records: [{ marker: "health-payload-marker" }] }, 500);
    },
  });
  broken.memory.tables.whoop_connections = harnessB.memory.tables.whoop_connections;
  const errorPath = await broken.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_profile", arguments: { user_id: userA } } },
  }));
  const errorBody = await errorPath.json();
  assert.equal(errorBody.error.message, "The tool could not be completed.");
  assert.equal(JSON.stringify(errorBody).includes("access-do-not-log-a"), false);
  assert.equal(JSON.stringify(errorBody).includes("health-payload-marker"), false);
  const aRow = harnessB.memory.tables.whoop_connections.find((row) => row.user_id === userA);
  const aBefore = aRow.encrypted_refresh_token;
  broken.memory.tables.whoop_connections.find((row) => row.user_id === userB).expires_at = new Date(0).toISOString();
  await broken.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_body_measurements", arguments: {} } },
  }));
  assert.equal(harnessB.memory.tables.whoop_connections.find((row) => row.user_id === userA).encrypted_refresh_token, aBefore);
  assertSafe(harness.logs);
  assertSafe(harnessB.logs);
  assertSafe(broken.logs);
});

test("a user past the public cap cannot complete a new WHOOP connection", async () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    user_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    seat_role: "public",
  }));
  const harness = createHarness({
    rows: { whoop_connections: rows },
    env: { WHOOP_LENS_DEVELOPER_USER_ID: developer.toUpperCase() },
    fetch: async () => jsonResponse(issuedTokens("dev")),
    randomUUID: () => "33333333-3333-4333-8333-333333333333",
  });
  const denied = await harness.handle(request("/connect", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { user_id: userA, contact_email: "attacker@example.com", access_token: "access-do-not-log", refresh_token: "refresh-do-not-log" },
  }));
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.code, "seat_full");
  assert.equal(deniedBody.destination, WAITLIST_DESTINATION);
  assert.equal(deniedBody.waitlist, "stored");
  assert.equal(deniedBody.authorization_url, undefined);
  assert.equal(harness.memory.tables.whoop_oauth_states.length, 0);
  assert.equal(harness.fetches.length, 0);
  const intake = harness.memory.tables.whoop_waitlist[0];
  assert.deepEqual(Object.keys(intake).sort(), ["contact_email", "destination", "user_id"]);
  assert.equal(intake.user_id, userB);
  assert.equal(intake.contact_email, "b@example.com");
  assert.equal(intake.destination, "whoop-lens@outlook.com");
  assert.equal(JSON.stringify(intake).includes("access-do-not-log"), false);
  const again = await harness.handle(request("/waitlist", {
    method: "POST",
    token: "session-do-not-log-b",
    body: { contact_email: "attacker@example.com", refresh_token: "refresh-do-not-log" },
  }));
  assert.equal((await again.json()).waitlist, "already_listed");
  assert.equal(harness.memory.tables.whoop_waitlist.length, 1);
  const dev = await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-dev", body: {} }));
  assert.equal(dev.status, 200);
  const callback = await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=33333333-3333-4333-8333-333333333333" }));
  assert.equal(callback.status, 302);
  assert.equal(new URL(callback.headers.get("location")).searchParams.get("connected"), "1");
  assert.equal(harness.memory.tables.whoop_connections.find((row) => row.user_id === developer).seat_role, "developer");
  const callbackFull = createHarness({
    rows: { whoop_connections: rows, whoop_oauth_states: [{ state: "state-b", user_id: userB, expires_at: new Date(2_000_000_000_000).toISOString() }] },
    fetch: async () => {
      throw new Error("token endpoint must not be called");
    },
  });
  const stopped = await callbackFull.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=state-b" }));
  assert.equal(stopped.status, 302);
  assert.equal(new URL(stopped.headers.get("location")).searchParams.get("waitlist"), "1");
  assert.equal(new URL(stopped.headers.get("location")).href.includes("oauth-code-do-not-log"), false);
  assert.equal(callbackFull.memory.tables.whoop_connections.some((row) => row.user_id === userB), false);
  assert.equal(callbackFull.memory.tables.whoop_oauth_states.length, 0);
  assert.equal(callbackFull.memory.tables.whoop_waitlist[0].destination, WAITLIST_DESTINATION);
  assertSafe(harness.logs);
  assertSafe(callbackFull.logs);
});

test("an existing connection can reconnect when seats are full and a lost race stores no tokens", async () => {
  const harness = createHarness({
    rows: {
      whoop_connections: [{ user_id: userA, seat_role: "public", scope: "old" }].concat(Array.from({ length: 8 }, (_, index) => ({
        user_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        seat_role: "public",
      }))),
    },
    env: { WHOOP_LENS_DEVELOPER_USER_ID: userA },
    fetch: async () => jsonResponse(issuedTokens("a")),
  });
  const connect = await harness.handle(request("/connect", { method: "POST", token: "session-do-not-log-a", body: {} }));
  assert.equal(connect.status, 200);
  const callback = await harness.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  assert.equal(callback.status, 302);
  assert.equal(harness.memory.tables.whoop_connections.find((row) => row.user_id === userA).seat_role, "developer");
  const raced = createHarness({
    fetch: async () => jsonResponse(issuedTokens("b")),
  });
  await raced.handle(request("/connect", { method: "POST", token: "session-do-not-log-b", body: {} }));
  raced.memory.failNextUpsert({ code: "P0001", message: "WHOOP integration is limited to 9 public seats" });
  const lost = await raced.handle(request("/callback", { search: "?code=oauth-code-do-not-log&state=11111111-1111-4111-8111-111111111111" }));
  assert.equal(lost.status, 302);
  assert.equal(new URL(lost.headers.get("location")).searchParams.get("waitlist"), "1");
  assert.equal(raced.memory.tables.whoop_connections.length, 0);
  assert.equal(raced.memory.tables.whoop_waitlist[0].user_id, userB);
  assert.equal(JSON.stringify(raced.memory.tables.whoop_waitlist).includes("access-do-not-log"), false);
  assert.equal(JSON.stringify(lost.headers.get("location")).includes("oauth-code-do-not-log"), false);
  assertSafe(harness.logs);
  assertSafe(raced.logs);
});
