import assert from "node:assert/strict";
import {
  createWhoopMcp,
} from "../whoop-mcp/handler.mjs";

export const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const developer = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
    health_connect_records: clone(initial.health_connect_records ?? []),
    medical_context_entries: clone(initial.medical_context_entries ?? []),
    health_import_consent: clone(initial.health_import_consent ?? []),
    health_connect_ingest_tokens: clone(initial.health_connect_ingest_tokens ?? []),
  };
  let upsertError = null;
  function from(name) {
    if (memoryApi.missingTables?.has(name)) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; }, range() { return query; },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist in schema cache" } }).then(resolve, reject);
        },
      };
      return query;
    }
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
  function withRollback(names, work) {
    const snapshot = {};
    for (const name of names) snapshot[name] = clone(tables[name]);
    try {
      return work();
    } catch (error) {
      for (const name of names) tables[name] = snapshot[name];
      throw error;
    }
  }
  function upsertConsent(userId, granted) {
    const next = { user_id: userId, purpose: "health_connect_file", granted_at: granted, withdrawn_at: null };
    const index = tables.health_import_consent.findIndex((row) => row.user_id === userId);
    if (index === -1) tables.health_import_consent.push(next);
    else tables.health_import_consent[index] = next;
  }
  function upsertHealth(row, userId, respectModified) {
    const payload = row.payload ?? null;
    const next = {
      id: row.id,
      user_id: userId,
      metric: row.metric,
      record_key: row.record_key,
      origin_package: row.origin_package ?? null,
      observed_at: row.observed_at,
      ended_at: row.ended_at ?? null,
      local_date: row.local_date ?? null,
      unit: row.unit,
      payload,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const index = tables.health_connect_records.findIndex((existing) =>
      existing.user_id === userId && existing.metric === next.metric && existing.record_key === next.record_key);
    if (index === -1) {
      tables.health_connect_records.push(next);
      return;
    }
    if (respectModified) {
      const oldModified = tables.health_connect_records[index].payload?.last_modified ?? null;
      const newModified = payload?.last_modified ?? null;
      if (oldModified != null && newModified != null && newModified < oldModified) return;
    }
    next.created_at = tables.health_connect_records[index].created_at ?? next.created_at;
    tables.health_connect_records[index] = next;
  }
  function runRpc(name, args = {}) {
    if (memoryApi.missingRpc?.has(name)) {
      const error = new Error("function not found in schema cache");
      error.code = "PGRST202";
      throw error;
    }
    if (name === "disconnect_whoop") {
      return withRollback(["whoop_oauth_states", "whoop_connections"], () => {
        tables.whoop_oauth_states = tables.whoop_oauth_states.filter((row) => row.user_id !== args.p_user_id);
        const before = tables.whoop_connections.length;
        tables.whoop_connections = tables.whoop_connections.filter((row) => row.user_id !== args.p_user_id);
        return { disconnected: true, removed: before - tables.whoop_connections.length === 1 };
      });
    }
    if (name === "import_health_connect_records") {
      return withRollback(["health_connect_records", "health_import_consent"], () => {
        if (!args.p_user_id || !args.p_granted_at || !Array.isArray(args.p_rows)) throw new Error("Import unavailable");
        upsertConsent(args.p_user_id, args.p_granted_at);
        let stored = 0;
        for (const row of args.p_rows) {
          if (memoryApi.failImportOnKey && row.record_key === memoryApi.failImportOnKey) throw new Error("synthetic");
          upsertHealth(row, args.p_user_id, false);
          stored += 1;
        }
        return { stored };
      });
    }
    if (name === "withdraw_health_connect_import") {
      return withRollback(["health_connect_records", "health_import_consent", "health_connect_ingest_tokens"], () => {
        const deleted = tables.health_connect_records.filter((row) => row.user_id === args.p_user_id).length;
        tables.health_connect_records = tables.health_connect_records.filter((row) => row.user_id !== args.p_user_id);
        for (const row of tables.health_import_consent) {
          if (row.user_id === args.p_user_id && row.purpose === "health_connect_file") row.withdrawn_at = new Date().toISOString();
        }
        let revoked = 0;
        for (const row of tables.health_connect_ingest_tokens) {
          if (row.user_id === args.p_user_id && row.revoked_at == null) {
            row.revoked_at = new Date().toISOString();
            revoked += 1;
          }
        }
        return { deleted, consent: "withdrawn", source: "health_connect", ingest_tokens_revoked: revoked };
      });
    }
    if (name === "issue_health_connect_ingest_token") {
      return withRollback(["health_connect_ingest_tokens", "health_import_consent"], () => {
        if (typeof args.p_token_hash !== "string" || !/^[0-9a-f]{64}$/.test(args.p_token_hash)) throw new Error("Import unavailable");
        let replaced = 0;
        for (const row of tables.health_connect_ingest_tokens) {
          if (row.user_id === args.p_user_id && row.revoked_at == null) {
            row.revoked_at = new Date().toISOString();
            replaced += 1;
          }
        }
        if (tables.health_connect_ingest_tokens.some((row) => row.token_hash === args.p_token_hash)) throw new Error("duplicate digest");
        if (tables.health_connect_ingest_tokens.some((row) => row.user_id === args.p_user_id && row.revoked_at == null)) {
          throw new Error("one active token");
        }
        tables.health_connect_ingest_tokens.push({
          token_hash: args.p_token_hash,
          user_id: args.p_user_id,
          created_at: new Date().toISOString(),
          revoked_at: null,
          window_started_at: null,
          window_hits: 0,
        });
        upsertConsent(args.p_user_id, args.p_granted_at);
        return { replaced_previous: replaced > 0 };
      });
    }
    if (name === "revoke_health_connect_ingest_tokens") {
      let revoked = 0;
      for (const row of tables.health_connect_ingest_tokens) {
        if (row.user_id === args.p_user_id && row.revoked_at == null) {
          row.revoked_at = new Date().toISOString();
          revoked += 1;
        }
      }
      return { revoked };
    }
    if (name === "consume_health_connect_ingest_rate") {
      const nowMs = Date.parse(args.p_now);
      const cutoff = nowMs - 15 * 60 * 1000;
      const row = tables.health_connect_ingest_tokens.find((item) => item.token_hash === args.p_token_hash && item.revoked_at == null);
      if (!row || !Number.isFinite(nowMs) || !(args.p_max_hits >= 1)) return false;
      const started = row.window_started_at ? Date.parse(row.window_started_at) : null;
      const expired = started == null || started <= cutoff;
      if (!expired && row.window_hits >= args.p_max_hits) return false;
      if (expired) {
        row.window_hits = 1;
        row.window_started_at = new Date(nowMs).toISOString();
      } else {
        row.window_hits += 1;
      }
      return true;
    }
    if (name === "upsert_health_connect_webhook_batch") {
      return withRollback(["health_connect_records"], () => {
        if (!Array.isArray(args.p_rows)) throw new Error("Import unavailable");
        for (const row of args.p_rows) upsertHealth(row, args.p_user_id, true);
        return { ok: true };
      });
    }
    const missing = new Error("function not found in schema cache");
    missing.code = "PGRST202";
    throw missing;
  }
  const memoryApi = {
    from,
    tables,
    missingTables: new Set(),
    missingRpc: new Set(),
    failImportOnKey: null,
    failNextUpsert(error) { upsertError = error; },
    rpc(name, args) {
      try {
        return Promise.resolve({ data: runRpc(name, args), error: null });
      } catch (error) {
        return Promise.resolve({ data: null, error: { code: error.code || "P0001", message: "Import unavailable" } });
      }
    },
  };
  return memoryApi;
}

export function createHarness(options = {}) {
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
    rpc: (name, args) => memory.rpc(name, args),
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

export function request(path, { method = "GET", token, body, search = "", headers = {} } = {}) {
  return new Request("https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp" + path + search, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function assertSafe(logs, extra = []) {
  const text = JSON.stringify(logs);
  for (const marker of secretMarkers.concat(extra)) assert.equal(text.includes(marker), false, marker);
}

export function tokenFetch(url) {
  return String(url).includes("/oauth/oauth2/token");
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function issuedTokens(label) {
  return {
    access_token: "access-do-not-log-" + label,
    refresh_token: "refresh-do-not-log-" + label,
    expires_in: 3600,
    scope: "offline read:profile",
  };
}
