import assert from "node:assert/strict";
import test from "node:test";
import { createAuthClient, safeRedirect, validateAuthorizationId, SUPABASE_URL, PUBLIC_KEY, MCP_URL } from "../docs/auth-client.mjs";

test("consent and session security controls", async () => {

const results = [];
const assert = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
const reject = async (fn, label) => { let failed = false; try { await fn(); } catch { failed = true; } assert(failed,label); };
await reject(() => safeRedirect("javascript:alert(1)"), "Blocks script redirects");
await reject(() => safeRedirect("http://attacker.example/callback"), "Blocks insecure external redirects");
await reject(() => safeRedirect("https://attacker.example/callback"), "Blocks arbitrary HTTPS hosts");
await reject(() => safeRedirect("https://chatgpt.com.attacker.example/callback"), "Blocks lookalike ChatGPT hosts");
await reject(() => safeRedirect("https://user:secret@chatgpt.com/callback"), "Blocks redirect credentials");
await reject(() => safeRedirect("http://chatgpt.com/connector_platform_oauth_redirect"), "Blocks insecure ChatGPT redirects");
await reject(() => safeRedirect("https://chatgpt.com:444/connector_platform_oauth_redirect"), "Blocks non-default ChatGPT ports");
assert(safeRedirect("https://chatgpt.com/connector_platform/oauth_redirect") === "https://chatgpt.com/connector_platform/oauth_redirect", "Allows the ChatGPT connector redirect host");
assert(safeRedirect("https://chatgpt.com/connector_platform_oauth_redirect") === "https://chatgpt.com/connector_platform_oauth_redirect", "Allows the stable ChatGPT connector redirect");
assert(safeRedirect("https://chatgpt.com/connector/oauth/callback-id").startsWith("https://chatgpt.com/connector/oauth/"), "Allows callback-specific ChatGPT connector redirects");
assert(new URL(safeRedirect("https://chatgpt.com/connector/oauth/callback-id?code=secret")).origin === "https://chatgpt.com", "Shows the ChatGPT origin without the full redirect URI");
assert(safeRedirect("http://127.0.0.1:1455/auth/callback").startsWith("http://127.0.0.1:1455/"), "Allows the Codex client loopback callback");
assert(safeRedirect("http://[::1]:1455/auth/callback").startsWith("http://[::1]:1455/"), "Allows the IPv6 Codex loopback callback");
assert(safeRedirect("http://localhost:1455/auth/callback").startsWith("http://localhost:1455/"), "Allows the localhost Codex loopback callback");
await reject(() => validateAuthorizationId("../token?grant_type=password"), "Blocks malformed authorization IDs");
const id = "12345678-1234-1234-1234-123456789abc";
assert(validateAuthorizationId(id) === id, "Accepts authorization UUIDs");
console.log("Passed " + results.length + " redirect security checks.");
});

test("legacy authentication fails closed without transmitting credentials or upstream bodies", async () => {
  let calls = 0;
  const auth = createAuthClient(async () => { calls++; throw Error("upstream-secret"); });
  for (const invoke of [() => auth.signIn("test@example.com", "test-password"),
    () => auth.details("synthetic"), () => auth.decide("synthetic", "approve"),
    () => auth.status(), () => auth.connect(), () => auth.signOut()]) {
    await assert.rejects(invoke, error => {
      assert.equal(error.message, "Legacy Supabase sign-in has been retired. Connect using https://whooplens.tech/mcp instead.");
      assert.doesNotMatch(error.message, /test-password|upstream-secret/);
      return true;
    });
  }
  assert.equal(calls, 0);
  assert.equal(SUPABASE_URL, "");
  assert.equal(PUBLIC_KEY, "");
  assert.equal(MCP_URL, "https://whooplens.tech/mcp");
});

test('independent Cloudflare callback is not a Supabase redirect target',()=>{
  const url='https://auth.whooplens.tech/oauth/upstream/callback?code=synthetic&state=synthetic';
  assert.throws(()=>safeRedirect(url));
  for(const bad of ['https://auth.whooplens.tech/other',
    'https://auth.whooplens.tech/oauth/upstream/callback/extra',
    'https://auth.whooplens.tech.evil.invalid/oauth/upstream/callback',
    'http://auth.whooplens.tech/oauth/upstream/callback',
    'https://auth.whooplens.tech/oauth/upstream/callback#token'])assert.throws(()=>safeRedirect(bad));
});
