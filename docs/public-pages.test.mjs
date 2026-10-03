import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openaiAppsChallengeResponse } from "../supabase/functions/whoop-mcp/challenge.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pages = ["../docs/index.html", "../docs/oauth/consent/index.html"].map(read);
const terms = read("../docs/terms/index.html");
const support = read("../docs/support/index.html");
const privacy = read("../docs/privacy/index.html");
const source = read("../supabase/functions/whoop-mcp/index.ts");

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
  assert.match(source, /req\.method === "GET" && u\.pathname\.endsWith\("\/\.well-known\/openai-apps-challenge"\)/);
  assert.match(source, /openaiAppsChallengeResponse\(Deno\.env\.get\("OPENAI_APPS_CHALLENGE"\)\)/);
  assert.doesNotMatch(source, /OPENAI_APPS_CHALLENGE"\s*\)\s*\|\|\s*"/);
});

test("every tool keeps readOnlyHint, destructiveHint, and openWorldHint", () => {
  assert.match(source, /const readOnly = \{ readOnlyHint: true, destructiveHint: false, openWorldHint: true \}/);
  assert.match(source, /const closed = \{ readOnlyHint: true, destructiveHint: false, openWorldHint: false \}/);
  const list = source.slice(source.indexOf('body.method === "tools/list"'), source.indexOf('body.method === "tools/call"'));
  for (const name of ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles", "get_samsung_health", "connect_whoop"]) {
    assert.match(list, new RegExp(name));
  }
  assert.deepEqual(list.match(/annotations: (?:readOnly|closed)/g), [
    "annotations: readOnly",
    "annotations: readOnly",
    "annotations: closed",
    "annotations: closed",
  ]);
});
