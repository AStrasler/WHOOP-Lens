import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openaiAppsChallengeResponse } from "../supabase/functions/whoop-mcp/challenge.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pages = ["../docs/index.html", "../docs/oauth/consent/index.html"].map(read);
const terms = read("../docs/terms/index.html");
const support = read("../docs/support/index.html");
const privacy = read("../docs/privacy/index.html");
const refresh = read("../docs/refresh/index.html");
const source = read("../supabase/functions/whoop-mcp/handler.mjs");
const entry = read("../supabase/functions/whoop-mcp/index.ts");

test("public pages name the private Cloudflare MCP and mark the Supabase path retired", () => {
  const readme = read("../README.md");
  assert.match(readme, /https:\/\/whooplens\.tech\/mcp/);
  assert.match(readme, /https:\/\/auth\.whooplens\.tech/);
  assert.match(readme, /WHOOP Stress Monitor history is not in the official WHOOP developer API/);
  assert.match(readme, /## Retired Supabase connector/);
  assert.doesNotMatch(readme, /Connect WHOOP on the existing connector/);
  assert.match(readme, /WHOOP connect is on/);
  assert.match(readme, /Cloudflare preview builds are off/);
  assert.doesNotMatch(readme, /WHOOP connect stays off/);
  assert.match(pages[0], /https:\/\/whooplens\.tech\/mcp/);
  assert.match(privacy, /https:\/\/whooplens\.tech\/mcp/);
  assert.match(read("../Privacy.md"), /https:\/\/whooplens\.tech\/mcp/);
});

test("landing page is a Cloudflare-only document with no scripts or Supabase", () => {
  const landing = pages[0];
  assert.doesNotMatch(landing, /<script/);
  assert.doesNotMatch(landing, /supabase/i);
  assert.match(landing, /script-src|default-src 'none'/);
  assert.doesNotMatch(landing, /connect-src/);
  assert.match(landing, /Cloudflare Access email one-time PIN/);
  assert.match(landing, /https:\/\/auth\.whooplens\.tech/);
  assert.doesNotMatch(landing, /Stress Monitor/);
  assert.doesNotMatch(landing, /dashboard/);
  for (const page of [privacy, terms, support, refresh]) {
    assert.doesNotMatch(page, /supabase/i);
    assert.doesNotMatch(page, /WHOOP-Lens\/dashboard/);
  }
});

test("retired consent page is a static moved notice linking home", () => {
  const moved = pages[1];
  assert.doesNotMatch(moved, /<script/);
  assert.doesNotMatch(moved, /supabase/i);
  assert.doesNotMatch(moved, /<form/);
  assert.match(moved, /This page has moved/);
  assert.match(moved, /href="\/WHOOP-Lens\/"/);
});

test("refresh page describes the Cloudflare connector and reconnect path", () => {
  assert.match(refresh, /<code>https:\/\/whooplens\.tech\/mcp<\/code>/);
  assert.match(refresh, /Cloudflare Access email one-time PIN/);
  assert.match(refresh, /connect_whoop/);
  assert.match(refresh, /Stress Monitor zone history is not available/);
});

test("sign-in and consent link privacy, terms, and support", () => {
  for (const page of pages) {
    assert.match(page, /href="\/WHOOP-Lens\/privacy\/"/);
    assert.match(page, /href="\/WHOOP-Lens\/terms\/"/);
    assert.match(page, /href="\/WHOOP-Lens\/support\/"/);
    assert.match(page, /Privacy statement/);
  }
});

test("terms cover independence, read-only access, revocation, and retained answers", () => {
  assert.match(terms, /independent integration/);
  assert.match(terms, /not affiliated with WHOOP/);
  assert.match(terms, /WHOOP access is read-only/);
  assert.match(terms, /revoke this integration in your WHOOP account settings/);
  assert.match(terms, /ChatGPT may keep answers it already received/);
  assert.doesNotMatch(terms, /\b(Inc\.|LLC|Ltd\.|GmbH)\b/);
});

test("support points at the GitHub issues page", () => {
  assert.match(support, /https:\/\/github\.com\/AStrasler\/WHOOP-Lens\/issues/);
});

test("privacy is published as a Pages page", () => {
  assert.match(privacy, /not affiliated with WHOOP/);
  assert.match(privacy, /https:\/\/astrasler\.github\.io\/WHOOP-Lens\/privacy\//);
  assert.match(read("../Privacy.md"), /https:\/\/astrasler\.github\.io\/WHOOP-Lens\/privacy\//);
  assert.match(privacy, /never more than 10/);
  assert.match(privacy, /AES-256-GCM/);
  assert.match(privacy, /whoop-lens@outlook.com/);
  assert.match(privacy, /does not include WHOOP access tokens/);
  assert.match(read("../Privacy.md"), /does not include WHOOP access tokens/);
});

test("challenge route returns the env token exactly and 404 when it is missing", async () => {
  const token = "abc def\n  ";
  const found = openaiAppsChallengeResponse(token);
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("content-type"), "text/plain");
  assert.equal(await found.text(), token);

  const missing = openaiAppsChallengeResponse(undefined);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/plain");
  assert.equal(await missing.text(), "");
});

test("the edge function serves the challenge from the environment on GET only", () => {
  const route = source.indexOf('pathname.endsWith("/.well-known/openai-apps-challenge")');
  const auth = source.indexOf("const me = await user(req)");
  assert.ok(route > -1 && route < auth);
  assert.match(source, /req\.method === "GET" && url\.pathname\.endsWith\("\/\.well-known\/openai-apps-challenge"\)/);
  assert.match(source, /openaiAppsChallengeResponse\(env\("OPENAI_APPS_CHALLENGE"\)\)/);
  assert.doesNotMatch(source, /OPENAI_APPS_CHALLENGE"\s*\)\s*\|\|\s*"/);
  assert.doesNotMatch(entry, /OPENAI_APPS_CHALLENGE"\s*\)\s*\|\|\s*"/);
  assert.match(entry, /env: \(name\) => Deno\.env\.get\(name\)/);
});

test("every tool keeps readOnlyHint, destructiveHint, and openWorldHint", () => {
  assert.match(source, /const readOnly = \{ readOnlyHint: true, destructiveHint: false, openWorldHint: true \}/);
  assert.match(source, /const closed = \{ readOnlyHint: true, destructiveHint: false, openWorldHint: false \}/);
  const list = source.slice(source.indexOf('body.method === "tools/list"'), source.indexOf('body.method === "tools/call"'));
  for (const name of ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_samsung_health", "get_health_connect", "get_medical_context", "get_capabilities", "connect_whoop"]) {
    assert.match(list, new RegExp(name));
  }
  assert.deepEqual(list.match(/annotations: (?:readOnly|closed)/g), [
    "annotations: readOnly",
    "annotations: readOnly",
    "annotations: closed",
    "annotations: closed",
    "annotations: closed",
    "annotations: closed",
    "annotations: closed",
  ]);
});

test("privacy notice covers owner-visible diagnostics and issue reports", () => {
  for (const page of [privacy, read("../Privacy.md")]) {
    assert.match(page, /Optional diagnostics and issue reports \(owner-visible\)/);
    assert.match(page, /best-effort/);
    assert.match(page, /health or personal details the member writes, is stored and shown to the server owner as written/);
    assert.match(page, /deleted after 30 days/);
    assert.match(page, /180 days after their last update/);
    assert.match(page, /pseudonymous member reference/);
  }
  assert.match(read("../Privacy.md"), /except the owner-visible diagnostics and issue reports/);
  assert.match(read("../Privacy.md"), /Last updated: October 20, 2026/);
});

test("repository privacy copy matches the Cloudflare-only published statement", () => {
  const md = read("../Privacy.md");
  assert.doesNotMatch(md, /supabase/i);
  assert.match(md, /stored in a Cloudflare D1 database/);
});

test("landing page tells new users to run connect_whoop", () => {
  assert.match(read("index.html"), /<code>connect_whoop<\/code>/);
});

test("privacy statements disclose stored Samsung Health records", () => {
  for (const page of [privacy, read("../Privacy.md")]) {
    assert.match(page, /Samsung Health records are stored for your account in the WhoopLens Cloudflare D1 database/);
  }
});

test("refresh guide uses connect_whoop and the Cloudflare server, not the retired setup site", () => {
  const md = read("REFRESH.md");
  assert.match(md, /connect_whoop/);
  assert.match(md, /https:\/\/whooplens\.tech\/mcp/);
  assert.doesNotMatch(md, /supabase|astrasler\.github\.io/i);
});

test("capability and workspace guides do not present Supabase as the working path", () => {
  const caps = read("CAPABILITIES.md");
  assert.doesNotMatch(caps, /Supabase connector remains/);
  assert.match(caps, /connect_whoop/);
  assert.match(read("WEB_WORKSPACE.md"), /\*\*Retired\.\*\*/);
});

test("disconnect wording is qualified for ended memberships", () => {
  assert.doesNotMatch(read("index.html"), /disconnect WHOOP from WhoopLens or revoke access in your WHOOP account settings at any time/);
  for (const page of [read("index.html"), privacy, read("../Privacy.md")]) assert.match(page, /membership has ended/);
});

test("landing page links the seat request form on auth.whooplens.tech", () => {
  const landing = read("index.html");
  assert.match(landing, /<a href="https:\/\/auth\.whooplens\.tech\/request-seat">/);
  assert.match(landing, /Do not include health information, passwords or tokens/);
  assert.doesNotMatch(landing, /<script|<form/);
});

test('privacy and support agree on a private deletion route', () => {
  const privacy = readFileSync(new URL('./privacy/index.html', import.meta.url), 'utf8');
  const support = readFileSync(new URL('./support/index.html', import.meta.url), 'utf8');
  assert.match(privacy, /request that deletion privately by email to whoop-lens@outlook\.com/);
  assert.doesNotMatch(privacy, /request that deletion through the support page\./);
  assert.match(support, /Private requests and data deletion/);
  assert.match(support, /mailto:whoop-lens@outlook\.com/);
  assert.match(support, /GitHub issues are public/);
  assert.match(support, /If your membership has ended/);
});
