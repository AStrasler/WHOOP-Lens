import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const doc = JSON.parse(read("./capabilities.json"));
const bundled = JSON.parse(read("../cloudflare/src/capabilities.json"));

test("public capabilities exactly match the deployed MCP bundle", () => {
  assert.deepEqual(doc, bundled);
  assert.equal(doc.schema_version, 1);
  assert.match(doc.registry_version, /^\d+\.\d+\.\d+-pr\d+$/);
});

test("every capability has honest requirements, limitations, prompts and lifecycle", () => {
  const ids = doc.capabilities.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const states = new Set(["available", "requires_connection_or_data", "planned", "unsupported"]);
  const providers = new Set(["mcp_data", "host_assisted", "planned", "unsupported"]);
  for (const item of doc.capabilities) {
    assert.match(item.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(item.name && item.description && item.provides);
    assert.ok(states.has(item.status));
    assert.ok(providers.has(item.delivery));
    assert.ok(Array.isArray(item.tools));
    assert.ok(Array.isArray(item.data_requirements) && item.data_requirements.length > 0);
    assert.ok(Array.isArray(item.limitations) && item.limitations.every(x => typeof x === "string" && x.length > 10) && item.limitations.length > 0);
    assert.ok(Array.isArray(item.example_prompts));
    if (item.status === "planned" || item.status === "unsupported") {
      assert.equal(item.tools.length, 0, item.id);
      assert.equal(item.example_prompts.length, 0, item.id);
    }
  }
  assert.ok(doc.global_limitations.some(x => /diagnos/i.test(x)));
  assert.ok(doc.global_limitations.some(x => /chart/i.test(x)));
  assert.ok(doc.global_limitations.some(x => /account/i.test(x)));
});

test("active data tools are exactly registered in the handler and not invented", () => {
  const source = read("../supabase/functions/whoop-mcp/handler.mjs");
  const knownDataTools = ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_samsung_health", "get_capabilities"];
  for (const item of doc.capabilities) {
    if (item.status !== "available") continue;
    for (const tool of item.tools) {
      assert.ok(knownDataTools.includes(tool), item.id + ": " + tool);
      assert.ok(source.includes('"' + tool + '"'), tool + " is absent from MCP");
    }
  }
  assert.match(source, /name: "get_capabilities"/);
  assert.match(source, /const fullInstructions = instructions \+ " " \+ discoveryGuidance/);
  assert.match(source, /stop charts immediately when the user opts out/);
  assert.match(source, /No EHR integration or automatic clinical record sharing/);
  assert.match(source, /Never invent studies/);
  assert.match(source, /WHOOP Stress Monitor history is not in the official WHOOP developer API/);
  assert.match(source, /Do not estimate those durations from cycle strain/);
  const stress = doc.capabilities.find((item) => item.id === "stress-monitor");
  assert.equal(stress.status, "unsupported");
  assert.equal(stress.tools.length, 0);
  assert.equal(doc.capabilities.find((item) => item.id === "stress-summary-note").delivery, "host_assisted");
});

test("public catalog never includes private measurements, credentials or account identifiers", () => {
  const text = read("./capabilities.json");
  assert.doesNotMatch(text, /(?<![a-z])Bearer\s|refresh_token|access_token|service_role|@outlook.com|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  assert.match(read("./CAPABILITIES.md"), /limitations/i);
});
