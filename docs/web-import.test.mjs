import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalImport, importSummary, WEB_HEALTH_UPLOADS_ENABLED, MAX_FILE_BYTES } from "./web-import.mjs";
import { readFileSync } from "node:fs";

const current = Date.parse("2026-10-11T12:00:00Z");
const sample = () => ({
  schema_version: 2, source: "health_connect", exported_at: "2026-10-11T11:00:00Z",
  user_id: "untrusted-user-must-be-ignored",
  records: [
    { metric: "steps_daily", record_key: "daily:2026-10-10:local",
      observed_at: "2026-10-10T05:00:00Z", ended_at: "2026-10-11T05:00:00Z",
      local_date: "2026-10-10", unit: "steps", payload: {count: 4321} },
    { metric: "heart_rate", record_key: "hr:1", observed_at: "2026-10-10T12:00:00Z",
      origin_package: "com.samsung.health", unit: "bpm", payload: {bpm: 71} }
  ]
});

test("web-first preview is permanently read-only until separately approved release", () => {
  assert.equal(WEB_HEALTH_UPLOADS_ENABLED, false);
  const page = readFileSync(new URL("./dashboard/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("./dashboard.mjs", import.meta.url), "utf8");
  assert.match(page, /Invite-only/i);
  assert.match(page, /cannot directly read Android Health Connect/i);
  assert.match(page, /Uploads disabled/);
  assert.match(page, /Content-Security-Policy/);
  assert.match(client, /createAuthClient\(\)/);
  assert.match(client, /connection\.connected !== true/);
  assert.match(client, /parseLocalImport\(raw\)/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|indexedDB|XMLHttpRequest|navigator\.serviceWorker|fetch\(/);
  assert.doesNotMatch(page + client, /service_role|sb_secret_/);
});

test("bounded Health Connect v2 files are canonicalized to the allowed records", () => {
  const parsed = parseLocalImport(JSON.stringify(sample()), current);
  assert.equal(parsed.kind, "health_connect_preview");
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.canUpload, false);
  assert.deepEqual(importSummary(parsed), [
    {kind: "steps_daily", count: 1}, {kind: "heart_rate", count: 1}
  ]);
  assert.equal(parsed.records[0].payload.count, 4321);
  assert.equal(parsed.records[1].origin_package, "com.samsung.health");
  assert.equal(Object.hasOwn(parsed.records[0], "user_id"), false);
  assert.equal(Object.hasOwn(parsed, "user_id"), false);
});

test("reject malformed, unsupported, oversized and repeated Health Connect rows", () => {
  for (const invalid of [
    {...sample(), source: "samsung_health"},
    {...sample(), schema_version: 1},
    {...sample(), records: Array.from({length:101}, () => sample().records[0])},
    {...sample(), records: [sample().records[0], sample().records[0]]},
    {...sample(), records: [{...sample().records[0], record_key:"cross/tenant/path"}]},
    {...sample(), records: [{...sample().records[0], payload:{count:100, diagnosis:"secret"}}]},
    {...sample(), records: [{...sample().records[0], payload:{count:-20}}]},
    {...sample(), records: [{...sample().records[0], unit:"liters"}]},
    {...sample(), records: [{...sample().records[0], local_date:"2026-02-30"}]},
    {...sample(), records: [{...sample().records[0], ended_at:"2026-10-09T00:00:00Z"}]},
  ]) assert.throws(() => parseLocalImport(JSON.stringify(invalid), current));
  assert.throws(() => parseLocalImport("{invalid", current), /not valid JSON/);
  assert.throws(() => parseLocalImport("x".repeat(MAX_FILE_BYTES+1), current), /too large|500 KB/);
});

test("FHIR R4 is a reviewed local preview, never a Health Connect upload", () => {
  const file = {resourceType:"Bundle",entry: [
    {resource:{resourceType:"Condition", code:{text:"Example condition"}, recordedDate:"2026-10-10"}},
    {resource:{resourceType:"MedicationStatement", medicationCodeableConcept:{text:"Example medication"}, effectiveDateTime:"2026-10-09"}},
    {resource:{resourceType:"Patient", name:[{text:"Personal identifier"}]}}
  ]};
  const r = parseLocalImport(JSON.stringify(file), current);
  assert.equal(r.kind, "fhir_preview");
  assert.equal(r.canUpload, false);
  assert.equal(r.records.length, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.records.some(x => JSON.stringify(x).includes("Personal identifier")), false);
});

test("browser-first pages have no automatic installation or live health upload", () => {
  const html=readFileSync(new URL("./dashboard/index.html", import.meta.url),"utf8");
  const js=readFileSync(new URL("./dashboard.mjs", import.meta.url),"utf8");
  assert.match(html,/no installed companion required/i);
  // Health files are never uploaded. Medical context (Issue #7 PR 4) may only be
  // written from the explicit review form, never from a selected file.
  assert.doesNotMatch(js,/samsung-health|Upload.*click|functions\/v1/);
  assert.match(js,/mc-reviewed"\)\.checked/);
  const fileHandler = js.slice(js.indexOf('$("health-file").addEventListener'), js.indexOf('$("medical-refresh")'));
  assert.doesNotMatch(fileHandler,/saveMedicalContext|updateMedicalContext/);
  assert.match(js,/document\.createElement\("strong"\)/);
  assert.match(js,/textContent/);
});
