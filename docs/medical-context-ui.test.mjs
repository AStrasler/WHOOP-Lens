import assert from "node:assert/strict";
import test from "node:test";
import { buildMedicalEntry, draftFromFhirCandidate, describeEntry } from "./medical-context-ui.mjs";
import { createAuthClient } from "./auth-client.mjs";

const form = { reviewed: true, category: "note", source_type: "self_reported", title: " Ask about sleep ", description: "", source_label: "", source_date: "2026-10-10" };

test("medical entry requires explicit review and valid fields", () => {
  assert.throws(() => buildMedicalEntry({ ...form, reviewed: false }), /reviewed/);
  assert.throws(() => buildMedicalEntry({ ...form, category: "diagnosis" }), /category/);
  assert.throws(() => buildMedicalEntry({ ...form, source_type: "ai" }), /came from/);
  assert.throws(() => buildMedicalEntry({ ...form, title: "" }), /title/);
  assert.throws(() => buildMedicalEntry({ ...form, source_date: "10/10/2026" }), /YYYY-MM-DD/);
  assert.deepEqual(buildMedicalEntry(form), {
    category: "note", source_type: "self_reported", detail_json: { title: "Ask about sleep" },
    source_label: null, source_date: "2026-10-10",
  });
});

test("FHIR candidates become unreviewed provider-labelled drafts", () => {
  const d = draftFromFhirCandidate({ type: "AllergyIntolerance", name: "Penicillin", date: "2026-01-02" });
  assert.equal(d.category, "allergy");
  assert.equal(d.source_type, "provider_document");
  assert.equal(d.reviewed, false);
  assert.throws(() => buildMedicalEntry(d), /reviewed/);
});

test("entries are described with their source", () => {
  assert.deepEqual(describeEntry({ category: "allergy", source_type: "provider_document", source_label: "Clinic", source_date: "2026-01-02", detail_json: { title: "Penicillin" } }),
    { title: "Penicillin", meta: "allergy · Provider document · Clinic · 2026-01-02" });
});

test("auth client sends medical-context writes only with approval and a valid ID", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/auth/v1/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAuthClient(fetcher, () => 0);
  await client.signIn("a@example.test", "pw");
  await client.saveMedicalContext(buildMedicalEntry(form));
  const save = calls.at(-1);
  assert.match(save.url, /\/functions\/v1\/medical-context$/);
  assert.equal(JSON.parse(save.init.body).approved, true);
  assert.throws(() => client.deleteMedicalContext("../x"), /Invalid entry ID/);
  await client.deleteMedicalContext("11111111-1111-4111-8111-111111111111");
  assert.equal(calls.at(-1).init.method, "DELETE");
});
