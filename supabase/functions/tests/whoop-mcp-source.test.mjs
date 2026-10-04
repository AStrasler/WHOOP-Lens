import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const functionDir = new URL("../whoop-mcp/", import.meta.url);
const lockPath = new URL("../../whoop-mcp.SOURCE.sha256", import.meta.url);

function deployBytes() {
  const names = readdirSync(functionDir).filter((name) => !name.startsWith(".")).sort();
  return names.map((name) => {
    const bytes = readFileSync(new URL(name, functionDir));
    const hash = createHash("sha256").update(bytes).digest("hex");
    return `${hash}  ${name}`;
  }).join("\n") + "\n";
}

test("deployed whoop-mcp files match the repo byte lock", () => {
  const actual = deployBytes();
  const expected = readFileSync(lockPath, "utf8");
  assert.equal(actual, expected, "whoop-mcp deploy bytes drifted. The files in supabase/functions/whoop-mcp are the deploy source of truth. Update supabase/whoop-mcp.SOURCE.sha256 in the same change.\n" + actual);
});

test("the linked-email pattern keeps the repo domain class", () => {
  const source = read("../whoop-mcp/handler.mjs");
  const landing = read("../../../docs/landing.mjs");
  assert.match(source, /@\[\^\\s@\]\{1,190\}/);
  assert.doesNotMatch(source, /@\[\^\^\\s@\]/);
  assert.match(landing, /@\[\^\\s@\]\{1,190\}/);
  assert.doesNotMatch(landing, /@\[\^\^\\s@\]/);
  const livePattern = /^[^\s@]{1,64}@[^^\s@]{1,190}\.[^\s@]{2,24}$/;
  const repoPattern = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
  assert.equal(repoPattern.test("user@example.com"), true);
  assert.equal(livePattern.test("user@example.com"), true);
  assert.equal(repoPattern.test("a@b^c.com"), true);
  assert.equal(livePattern.test("a@b^c.com"), false);
});

test("verify_jwt stays false and this config does not name samsung-health", () => {
  const config = read("../../config.toml");
  assert.match(config, /\[functions\.whoop-mcp\]/);
  assert.match(config, /verify_jwt = false/);
  assert.doesNotMatch(config, /verify_jwt\s*=\s*true/);
  assert.doesNotMatch(config, /samsung-health/);
  assert.match(read("../whoop-mcp/index.ts"), /createWhoopMcp/);
  assert.match(read("../whoop-mcp/handler.mjs"), /https:\/\/evoiwauqplbcecumiwqn\.supabase\.co\/functions\/v1\/whoop-mcp\/callback/);
});

test("the seat migration caps 9 public seats and 1 developer seat without token columns", () => {
  const sql = read("../../migrations/20261004120000_whoop_connection_seats_and_waitlist.sql");
  assert.match(sql, /public_seats >= 9/);
  assert.match(sql, /developer_seats >= 1/);
  assert.match(sql, /WHOOP integration is limited to 9 public seats/);
  assert.match(sql, /WHOOP developer seat is already taken/);
  assert.match(sql, /whoop-lens@outlook.com/);
  assert.match(sql, /enable row level security/);
  assert.doesNotMatch(sql, /@\[\^\^\\s@\]/);
  const table = sql.slice(sql.indexOf("create table public.whoop_waitlist"), sql.indexOf("comment on table public.whoop_waitlist"));
  assert.match(table, /user_id uuid/);
  assert.match(table, /contact_email text/);
  assert.match(table, /destination text/);
  assert.doesNotMatch(table, /encrypted_|refresh_token|access_token|client_secret|authorization|health/i);
});
