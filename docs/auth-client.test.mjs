import test from "node:test";
import { createAuthClient, safeRedirect, validateAuthorizationId, SUPABASE_URL } from "../docs/auth-client.mjs";

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
let time = 1000;
const calls = [];
const fakeFetch = async (url, options) => {
 calls.push({url, options});
 if (url.endsWith("/token?grant_type=password")) return {ok:true,status:200,json:async()=>({access_token:"private-test-token",refresh_token:"private-refresh-token",expires_in:60,user:{email:"test@example.com"}})};
 return {ok:true,status:200,json:async()=>({authorization_id:id})};
};
const auth = createAuthClient(fakeFetch, () => time);
await reject(() => auth.details(id), "Requires sign-in before reading consent");
assert(calls.length === 0, "Does not send unauthenticated consent requests");
const user = await auth.signIn("test@example.com","test-password");
assert(!("access_token" in user) && !("refresh_token" in user), "Keeps session tokens out of UI results");
assert(!calls[0].options.headers.Authorization, "Does not send a prior session when signing in");
await auth.details(id);
assert(calls[1].url === SUPABASE_URL + "/auth/v1/oauth/authorizations/" + id, "Uses the fixed Supabase consent endpoint");
assert(calls[1].options.headers.Authorization === "Bearer private-test-token", "Sends the session only to the trusted API");
assert(calls[1].options.redirect === "error" && calls[1].options.credentials === "omit", "Rejects fetch redirects and ambient cookies");
await reject(() => auth.decide(id, "autoapprove"), "Rejects invalid decisions");
await auth.decide(id, "deny");
assert(JSON.parse(calls.at(-1).options.body).action === "deny", "Submits denial explicitly");
time = 62000;
await reject(() => auth.status(), "Expires browser sessions");
const before = calls.length;
await reject(() => auth.connect(), "Cannot link WHOOP after session expiry");
assert(calls.length === before, "Does not send expired credentials");
await auth.signIn("test@example.com","test-password");
await auth.signOut();
await reject(() => auth.details(id), "Sign-out clears the session");
console.log("Passed " + results.length + " security checks.");

});

