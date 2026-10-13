import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importHealthConnectFile, IMPORT_CONSENT } from "../whoop-mcp/health-import.mjs";
import { healthConnectWebhook, ISSUE_CONSENT, REVOKE_CONFIRM } from "../whoop-mcp/health-connect-webhook.mjs";
import { createHarness, jsonResponse, request, userA, userB } from "./harness.mjs";

const NOW = Date.parse("2026-10-13T03:00:00Z");
const UNSUPPORTED = ["distance", "active_calories", "total_calories", "weight", "height", "blood_pressure", "blood_glucose", "oxygen_saturation", "body_temperature", "skin_temperature", "respiratory_rate", "resting_heart_rate", "heart_rate_variability", "hydration", "nutrition", "basal_metabolic_rate", "body_fat", "lean_body_mass", "body_water_mass", "bmi", "vo2_max", "bone_mass", "menstruation_flow", "menstruation_period", "intermenstrual_bleeding", "ovulation_test", "cervical_mucus", "sexual_activity", "basal_body_temperature"];
const file = {
  schema_version: 2,
  source: "health_connect",
  exported_at: "2026-10-11T11:00:00Z",
  user_id: userB,
  records: [{
    metric: "steps_daily",
    record_key: "daily:2026-10-10:local",
    observed_at: "2026-10-10T05:00:00Z",
    ended_at: "2026-10-11T05:00:00Z",
    local_date: "2026-10-10",
    origin_package: "com.samsung.health",
    unit: "steps",
    payload: { count: 4321 },
  }],
};
const on = {
  WHOOP_DISCONNECT_ENABLED: "true",
  WEB_HEALTH_IMPORT_ENABLED: "true",
  HEALTH_CONNECT_WEBHOOK_ENABLED: "true",
  MCP_2026_07_28_ENABLED: "true",
};

function harness(env = {}, rows) {
  const h = createHarness({ env, rows, fetch: async () => jsonResponse({}), now: NOW });
  return h;
}
function call(h, token, name, args, id = 7) {
  return h.handle(request("/mcp", {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  }));
}
function payload(extra = {}) {
  return { timestamp: "2026-10-13T03:00:00.000Z", app_version: "1.9.22", user_id: userB, ...extra };
}
async function issue(h, token = "session-do-not-log-a") {
  const response = await call(h, token, "issue_health_connect_ingest_token", { consent: ISSUE_CONSENT });
  const body = await response.json();
  assert.equal(body.result.isError, undefined);
  const data = JSON.parse(body.result.content[0].text);
  assert.equal(data.shown_once, true);
  assert.equal(data.header_name, "Authorization");
  assert.match(data.header_value, /^Bearer hct_[A-Za-z0-9_-]{43}$/);
  return data.header_value.slice("Bearer ".length);
}
function post(h, token, body, options = {}) {
  return healthConnectWebhook(new Request("https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/api/health-connect/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), { enabled: true, db: h.db }, { now: NOW, ...options });
}

test("vendored Health Connect parser matches the Pages preview", () => {
  for (const name of ["web-import.mjs", "fhir-preview.mjs"]) {
    const deployed = readFileSync(new URL("../whoop-mcp/" + name, import.meta.url), "utf8");
    const preview = readFileSync(new URL("../../../docs/" + name, import.meta.url), "utf8");
    assert.equal(deployed, preview);
  }
});

test("new account tools and the webhook stay off unless their flags are true", async () => {
  const h = harness();
  const listed = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  }));
  const tools = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_capabilities", "get_medical_context", "get_health_connect", "get_samsung_health", "connect_whoop"]);
  const blocked = await call(h, "session-do-not-log-a", "import_health_connect_file", {
    consent: "store-health-connect-file",
    file_json: JSON.stringify(file),
  });
  const body = await blocked.json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, "WHOOP data is unavailable for this connection.");
  assert.equal(h.memory.tables.health_connect_records.length, 0);
  const webhook = await h.handle(request("/api/health-connect/webhook", {
    method: "POST",
    body: payload(),
    token: "hct_" + "a".repeat(43),
  }));
  assert.equal(webhook.status, 503);
  assert.equal((await webhook.json()).error, "Health Connect webhook is not activated");
  const discover = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 2, method: "server/discover" },
  }));
  assert.equal(discover.status, 400);
  assert.equal((await discover.json()).error.code, -32601);
  const sql = readFileSync(new URL("../../migrations/20261013120000_health_connect_consent_and_ingest.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /token_hash text primary key/);
  assert.match(sql, /revoked_at is null/);
  assert.doesNotMatch(sql, /create table[\s\S]*\btoken text\b/);
  assert.match(readFileSync(new URL("../../config.toml", import.meta.url), "utf8"), /verify_jwt = false/);
});

test("file import stores only the caller rows and a failed row rolls back consent", async () => {
  const h = harness({ WEB_HEALTH_IMPORT_ENABLED: "true", HEALTH_CONNECT_WEBHOOK_ENABLED: "true" });
  const denied = await call(h, "session-do-not-log-a", "import_health_connect_file", { file_json: "{}" });
  assert.equal((await denied.json()).error.code, -32602);
  const fhir = await call(h, "session-do-not-log-a", "import_health_connect_file", {
    consent: "store-health-connect-file",
    file_json: JSON.stringify({ resourceType: "Bundle", entry: [] }),
  });
  assert.match((await fhir.json()).result.content[0].text, /FHIR bundles stay a local preview/);
  assert.equal(h.memory.tables.health_connect_records.length, 0);
  const saved = await call(h, "session-do-not-log-a", "import_health_connect_file", {
    consent: "store-health-connect-file",
    file_json: JSON.stringify(file),
  });
  const imported = JSON.parse((await saved.json()).result.content[0].text);
  assert.equal(imported.stored, 1);
  assert.equal(imported.transport, "web_file_import");
  assert.equal(imported.live_sync, undefined);
  const row = h.memory.tables.health_connect_records[0];
  assert.equal(row.user_id, userA);
  assert.equal(row.payload.count, 4321);
  const read = await call(h, "session-do-not-log-b", "get_health_connect", {});
  assert.equal(JSON.parse((await read.json()).result.content[0].text).records.length, 0);
  const withdrawn = await call(h, "session-do-not-log-a", "withdraw_health_connect_import", {
    confirm: "delete-my-health-connect-records",
  });
  const removal = JSON.parse((await withdrawn.json()).result.content[0].text);
  assert.equal(removal.deleted, 1);
  assert.equal(removal.consent, "withdrawn");
  assert.equal(h.memory.tables.health_connect_records.length, 0);
  assert.equal(h.memory.tables.health_import_consent[0].withdrawn_at == null, false);

  const second = {
    ...file.records[0],
    record_key: "daily:2026-10-09:local",
    observed_at: "2026-10-09T05:00:00Z",
    ended_at: "2026-10-10T05:00:00Z",
    local_date: "2026-10-09",
  };
  h.memory.failImportOnKey = second.record_key;
  await assert.rejects(
    importHealthConnectFile(h.db, userA, { ...file, records: [file.records[0], second] }, IMPORT_CONSENT, { now: NOW }),
    /Import unavailable/,
  );
  assert.equal(h.memory.tables.health_connect_records.length, 0);
  h.memory.failImportOnKey = null;
  const ok = await importHealthConnectFile(h.db, userA, { ...file, records: [file.records[0], second] }, IMPORT_CONSENT, { now: NOW });
  assert.equal(ok.stored, 2);
  assert.equal(h.memory.tables.health_connect_records.every((item) => item.user_id === userA), true);
});

test("disconnect removes only this account's stored WHOOP credentials", async () => {
  const rows = {
    whoop_connections: [
      { user_id: userA, encrypted_access_token: "access-do-not-log", encrypted_refresh_token: "refresh-do-not-log", seat_role: "public" },
      { user_id: userB, encrypted_access_token: "access-do-not-log", encrypted_refresh_token: "refresh-do-not-log", seat_role: "public" },
    ],
    whoop_oauth_states: [
      { state: "state-a", user_id: userA },
      { state: "state-b", user_id: userB },
    ],
  };
  const off = harness({}, structuredClone(rows));
  const blocked = await call(off, "session-do-not-log-a", "disconnect_whoop", {});
  assert.equal((await blocked.json()).result.isError, true);
  assert.equal(off.memory.tables.whoop_connections.length, 2);
  const h = harness({ WHOOP_DISCONNECT_ENABLED: "true" }, rows);
  const removed = JSON.parse((await (await call(h, "session-do-not-log-a", "disconnect_whoop", {})).json()).result.content[0].text);
  assert.equal(removed.disconnected, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(h.memory.tables.whoop_connections.map((row) => row.user_id), [userB]);
  assert.deepEqual(h.memory.tables.whoop_oauth_states.map((row) => row.user_id), [userB]);
  const again = JSON.parse((await (await call(h, "session-do-not-log-a", "disconnect_whoop", {})).json()).result.content[0].text);
  assert.equal(again.removed, false);
  assert.equal(JSON.stringify(h.logs).includes("access-do-not-log"), false);
  assert.equal(h.fetches.length, 0);
});

test("webhook auth failure, a foreign user id, and a disabled member never write another account", async () => {
  const h = harness(on);
  const logs = [];
  const originals = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((name) => [name, console[name]]));
  for (const name of Object.keys(originals)) console[name] = (...args) => logs.push(args.map(String).join(" "));
  try {
    const off = harness({ WEB_HEALTH_IMPORT_ENABLED: "true" });
    assert.equal((await off.handle(request("/api/health-connect/webhook", { method: "POST", body: payload() }))).status, 503);
    const token = await issue(h);
    assert.equal(JSON.stringify(h.memory.tables.health_connect_ingest_tokens).includes(token), false);
    assert.equal(h.memory.tables.health_connect_ingest_tokens.filter((row) => row.token_hash?.length === 64).length, 1);
    assert.equal((await post(h, null, payload())).status, 401);
    assert.equal((await post(h, "hct_" + "b".repeat(43), payload())).status, 401);
    assert.equal((await healthConnectWebhook(new Request("https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/api/health-connect/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic aGk=" },
      body: "{}",
    }), { enabled: true, db: h.db }, { now: NOW })).status, 401);
    assert.equal((await post(h, token, "{")).status, 400);
    assert.equal((await post(h, token, { app_version: "1.9.22" })).status, 400);
    const saved = await post(h, token, payload({
      steps: [{ count: 10, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-13T00:00:00Z", user_id: userB, metadata: { id: "step-a", data_origin: "com.sec.android.app.shealth" } }],
    }));
    assert.equal(saved.status, 200);
    const row = h.memory.tables.health_connect_records[0];
    assert.equal(row.user_id, userA);
    assert.equal(row.metric, "steps_daily");
    assert.equal(row.record_key, "hc:step-a");
    assert.equal(row.payload.count, 10);
    assert.equal(h.memory.tables.health_connect_records.filter((item) => item.user_id === userB).length, 0);
    const body = await saved.json();
    assert.equal(JSON.stringify(body).includes(userB), false);
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(logs.some((line) => line.includes(token) || line.includes("step-a")), false);
    assert.equal(JSON.stringify(h.logs).includes(token), false);
    assert.equal(JSON.stringify(h.logs).includes("step-a"), false);
    h.memory.tables.whoop_members.push({ user_id: userA, active: false });
    assert.equal((await post(h, token, payload({ steps: [{ count: 1, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-12T01:00:00Z" }] }))).status, 403);
    assert.equal(h.memory.tables.health_connect_records.length, 1);
  } finally {
    for (const [name, fn] of Object.entries(originals)) console[name] = fn;
  }
});

test("two members stay isolated, retries upsert, and unsupported types still return 2xx", async () => {
  const h = harness(on);
  const tokenA = await issue(h);
  const tokenB = await issue(h, "session-do-not-log-b");
  const steps = (count, id = "step-1", modified = "2026-10-13T02:00:00Z") => ({
    count,
    start_time: "2026-10-12T00:00:00Z",
    end_time: "2026-10-13T00:00:00Z",
    metadata: { id, data_origin: "com.sec.android.app.shealth", lastModifiedTime: modified },
  });
  const common = {
    steps: [steps(100)],
    sleep: [{ session_end_time: "2026-10-13T06:00:00Z", duration_seconds: 28800, stages: [{ stage: "deep", start_time: "2026-10-12T22:00:00Z", end_time: "2026-10-13T00:00:00Z", duration_seconds: 7200 }], metadata: { id: "sleep-1", data_origin: "com.sec.android.app.shealth" } }],
    heart_rate: [
      { bpm: 72, time: "2026-10-13T08:15:00Z", metadata: { id: "hr-1" } },
      { time: "2026-10-13T08:16:00Z", avg: 80.5, min: 70, max: 90, bpm: 80.5, metadata: { id: "hr-2" } },
    ],
    exercise: [{ type: "running", start_time: "2026-10-13T07:00:00Z", end_time: "2026-10-13T07:30:00Z", duration_seconds: 1800, metadata: { id: "ex-1", data_origin: "com.sec.android.app.shealth" } }],
  };
  for (const key of UNSUPPORTED) common[key] = [{ marker: key }];
  const first = await (await post(h, tokenA, payload(common))).json();
  assert.equal(first.ok, true);
  assert.equal(first.stored, 5);
  assert.equal(first.skipped, UNSUPPORTED.length + 1);
  assert.equal(first.skipped_types.user_id, 1);
  assert.equal(first.skipped_types.heart_rate_variability, 1);
  assert.equal(first.skipped_types.resting_heart_rate, 1);
  assert.equal(first.rejected, 0);
  const metrics = [...new Set(h.memory.tables.health_connect_records.filter((row) => row.user_id === userA).map((row) => row.metric))].sort();
  assert.deepEqual(metrics, ["exercise_session", "heart_rate", "sleep_session", "steps_daily"]);
  const sleep = h.memory.tables.health_connect_records.find((row) => row.metric === "sleep_session").payload;
  assert.equal(sleep.duration_seconds, 28800);
  assert.equal(sleep.stages[0].stage, "deep");
  const hr = h.memory.tables.health_connect_records.find((row) => row.record_key === "hc:hr-2").payload;
  assert.equal(hr.bpm, 80.5);
  assert.equal(hr.min, 70);
  const again = await (await post(h, tokenA, payload({ steps: [steps(250)] }))).json();
  assert.equal(again.stored, 1);
  assert.equal(h.memory.tables.health_connect_records.filter((row) => row.user_id === userA && row.metric === "steps_daily").length, 1);
  assert.equal(h.memory.tables.health_connect_records.find((row) => row.record_key === "hc:step-1" && row.user_id === userA).payload.count, 250);
  const stale = await (await post(h, tokenA, payload({ steps: [steps(1, "step-1", "2026-10-13T01:00:00Z")] }))).json();
  assert.equal(stale.stored, 1);
  assert.equal(h.memory.tables.health_connect_records.find((row) => row.record_key === "hc:step-1" && row.user_id === userA).payload.count, 250);
  const plain = { count: 4, start_time: "2026-10-12T10:00:00Z", end_time: "2026-10-12T11:00:00Z", metadata: { data_origin: "com.sec.android.app.shealth", recording_method: "automatically_recorded" } };
  await post(h, tokenA, payload({ steps: [plain] }));
  await post(h, tokenA, payload({ steps: [{ ...plain, count: 9 }] }));
  const plainRows = h.memory.tables.health_connect_records.filter((row) => row.user_id === userA && row.record_key.startsWith("k:"));
  assert.equal(plainRows.length, 1);
  assert.equal(plainRows[0].payload.count, 9);
  const other = await (await post(h, tokenB, payload({ steps: [steps(3, "step-1")], heart_rate_variability: [{ rmssd_millis: 20, time: "2026-10-13T08:00:00Z" }] }))).json();
  assert.equal(other.stored, 1);
  assert.equal(other.skipped, 2);
  assert.equal(h.memory.tables.health_connect_records.filter((row) => row.user_id === userB).length, 1);
  assert.equal(h.memory.tables.health_connect_records.find((row) => row.user_id === userA && row.record_key === "hc:step-1").payload.count, 250);
  assert.equal(h.memory.tables.health_connect_records.find((row) => row.user_id === userB && row.record_key === "hc:step-1").payload.count, 3);
  assert.equal((await post(h, tokenA, payload({ steps: [{ count: 1, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-12T01:00:00Z" }] }), { maxBody: 40 })).status, 413);
  assert.equal((await post(h, tokenA, payload({ heart_rate: [{ bpm: 60, time: "2026-10-13T09:00:00Z" }, { bpm: 61, time: "2026-10-13T09:01:00Z" }] }), { maxStored: 1 })).status, 413);
  const onlySkipped = await (await post(h, tokenA, payload({ distance: [{ meters: 1 }] }))).json();
  assert.equal(onlySkipped.ok, true);
  assert.equal(onlySkipped.stored, 0);
  assert.equal(onlySkipped.skipped, 2);
});

test("issuing a token grants consent, rotation and withdrawal revoke it, and the other member is untouched", async () => {
  const h = harness(on);
  const off = harness({ WEB_HEALTH_IMPORT_ENABLED: "true" });
  const disabled = await call(off, "session-do-not-log-a", "issue_health_connect_ingest_token", { consent: ISSUE_CONSENT });
  assert.equal((await disabled.json()).result.isError, true);
  assert.equal(off.memory.tables.health_connect_ingest_tokens.length, 0);
  const first = await issue(h);
  const consent = h.memory.tables.health_import_consent.find((row) => row.user_id === userA);
  assert.equal(consent.purpose, "health_connect_file");
  assert.equal(consent.withdrawn_at, null);
  const second = await issue(h);
  assert.notEqual(first, second);
  assert.equal((await post(h, first, payload({ steps: [{ count: 1, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-12T01:00:00Z" }] }))).status, 401);
  const kept = await issue(h, "session-do-not-log-b");
  await post(h, second, payload({ steps: [{ count: 8, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-13T00:00:00Z", metadata: { id: "owned-by-a" } }] }));
  await post(h, kept, payload({ steps: [{ count: 2, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-13T00:00:00Z", metadata: { id: "owned-by-b" } }] }));
  const revoked = await call(h, "session-do-not-log-a", "revoke_health_connect_ingest_token", { confirm: REVOKE_CONFIRM });
  assert.equal(JSON.parse((await revoked.json()).result.content[0].text).revoked, 1);
  assert.equal(h.memory.tables.health_connect_records.filter((row) => row.user_id === userA).length, 1);
  assert.equal((await post(h, second, payload())).status, 401);
  assert.equal((await post(h, kept, payload({ steps: [{ count: 2, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-13T00:00:00Z", metadata: { id: "owned-by-b" } }] }))).status, 200);
  const fresh = await issue(h);
  const gone = await call(h, "session-do-not-log-a", "withdraw_health_connect_import", { confirm: "delete-my-health-connect-records" });
  const withdrawal = JSON.parse((await gone.json()).result.content[0].text);
  assert.equal(withdrawal.deleted, 1);
  assert.equal(withdrawal.consent, "withdrawn");
  assert.equal(withdrawal.ingest_tokens_revoked, 1);
  assert.equal(h.memory.tables.health_connect_records.filter((row) => row.user_id === userA).length, 0);
  assert.equal(h.memory.tables.health_connect_records.filter((row) => row.user_id === userB).length, 1);
  assert.equal((await post(h, fresh, payload({ steps: [{ count: 1, start_time: "2026-10-12T00:00:00Z", end_time: "2026-10-12T01:00:00Z" }] }))).status, 401);
  assert.equal((await post(h, kept, payload())).status, 200);
  const rateToken = await issue(h, "session-do-not-log-b");
  let limited = 0;
  for (let i = 0; i < 3; i += 1) {
    const response = await post(h, rateToken, payload(), { maxHits: 2 });
    if (response.status === 429) limited += 1;
    else assert.equal(response.status, 200);
  }
  assert.equal(limited, 1);
  const listed = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  }));
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(names.slice(0, 11), ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_capabilities", "get_medical_context", "get_health_connect", "get_samsung_health", "connect_whoop"]);
  assert.deepEqual(names.slice(11), ["disconnect_whoop", "import_health_connect_file", "withdraw_health_connect_import", "issue_health_connect_ingest_token", "revoke_health_connect_ingest_token"]);
});

test("MCP 2026-07-28 discover reports supportedVersions and leaves legacy initialize unchanged", async () => {
  const h = harness(on);
  const headers = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "server/discover",
  };
  const discover = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    headers,
    body: { jsonrpc: "2.0", id: 4, method: "server/discover" },
  }));
  assert.equal(discover.status, 200);
  const discovery = (await discover.json()).result;
  assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
  assert.equal(discovery.resultType, "complete");
  assert.equal(discovery.ttlMs, 0);
  assert.equal(discovery.cacheScope, "private");
  assert.equal(discovery.serverInfo.name, "whoop-lens");
  assert.equal(discovery.serverInfo.version, "1.0.0");
  assert.deepEqual(discovery._meta, { "io.modelcontextprotocol/serverInfo": discovery.serverInfo });
  assert.match(discovery.instructions, /WHOOP Stress Monitor history is not in the official WHOOP developer API/);
  assert.match(discovery.instructions, /Do not estimate those durations/);
  const modernList = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: { jsonrpc: "2.0", id: 5, method: "tools/list" },
  }));
  const listed = (await modernList.json()).result;
  assert.equal(listed.resultType, "complete");
  assert.equal(listed.cacheScope, "private");
  assert.equal(listed.tools.length, 16);
  const modernInit = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "initialize" },
    body: { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
  }));
  assert.equal((await modernInit.json()).error.code, -32601);
  const legacy = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    body: { jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "2025-03-26" } },
  }));
  assert.equal((await legacy.json()).result.protocolVersion, "2025-06-18");
  const mismatch = await h.handle(request("/mcp", {
    method: "POST",
    token: "session-do-not-log-a",
    headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" },
    body: { jsonrpc: "2.0", id: 9, method: "tools/list" },
  }));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "MCP method header mismatch");
});
