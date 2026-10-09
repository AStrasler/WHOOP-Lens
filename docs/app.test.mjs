import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("const auth = createAuthClient();", "const auth = testAuth;");
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup({ connected = false, approved = false, blocked = false, failConnect = false } = {}) {
  const elements = new Map();
  const calls = [];
  let isConnected = connected;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: ["consent", "connection", "connect", "account"].includes(id),
      value: id === "email" ? "family@example.test" : "password",
      classList: { toggle() {} },
      listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; }
    });
    return elements.get(id);
  };
  const popup = { opener: {}, closed: false,
    location: { replace(url) { calls.push(["whoop", url]); } },
    close() { this.closed = true; } };
  const win = { listeners: {}, open() { calls.push(["open"]); return blocked ? null : popup; },
    addEventListener(event, handler) { this.listeners[event] = handler; } };
  win.top = win; win.self = win;
  const location = { search: "?authorization_id=pending-request", pathname: "/WHOOP-Lens/oauth/consent",
    assign(url) { calls.push(["redirect", url]); }, replace() {} };
  const testAuth = {
    async signIn() { return { email: "family@example.test" }; },
    async status() { calls.push(["status"]); return { connected: isConnected }; },
    async details() { calls.push(["details"]); return approved
      ? { redirect_url: "https://chatgpt.com/connector-callback?code=test" }
      : { authorization_id: "pending-request", client: { name: "ChatGPT" }, redirect_uri: "https://chatgpt.com/connector-callback", scope: "email" }; },
    async decide(id, action) { calls.push(["decide", id, action]); return { redirect_url: "https://chatgpt.com/connector-callback?code=test" }; },
    async connect() { calls.push(["connect"]); if (failConnect) throw new Error("Connect failed");
      return { authorization_url: "https://api.prod.whoop.com/oauth/oauth2/auth?state=test" }; }
  };
  vm.runInNewContext(source, { testAuth, window: win, location, URL, URLSearchParams,
    document: { getElementById: element, querySelectorAll: () => [...elements.values()], body: {} },
    validateAuthorizationId: value => value, safeRedirect: value => value, MCP_URL: "https://example.test",
    landingNote: () => null });
  return { element, calls, popup, win, setConnected(value) { isConnected = value; },
    async click(id, event = "click") { element(id).listeners[event]({ preventDefault() {} }); await settle(); },
    async login() { element("login").listeners.submit({ preventDefault() {} }); await settle(); }
  };
}
test("unconnected user cannot approve or finish MCP authentication", async () => {
  const h = setup(); await h.login();
  assert.equal(h.element("consent").hidden, true);
  assert.equal(h.element("connection").hidden, false);
  assert.equal(h.element("connect").hidden, false);
  await h.click("approve");
  assert.equal(h.calls.some(c => c[0] === "decide" || c[0] === "redirect"), false);
});
test("WHOOP opens separately and original request resumes after verified connection", async () => {
  const h = setup(); await h.login(); await h.click("connect");
  assert.equal(h.popup.opener, null);
  assert.equal(h.calls.some(c => c[0] === "whoop"), true);
  assert.equal(h.calls.some(c => c[0] === "redirect"), false);
  h.setConnected(true); await h.click("retry");
  assert.equal(h.element("consent").hidden, false);
  await h.click("approve");
  assert.deepEqual(h.calls.find(c => c[0] === "decide"), ["decide", "pending-request", "approve"]);
  assert.equal(h.calls.some(c => c[0] === "redirect"), true);
});
test("previous app grant does not bypass missing WHOOP connection", async () => {
  const h = setup({ approved: true }); await h.login();
  assert.equal(h.calls.some(c => c[0] === "details"), false);
  h.setConnected(true); await h.click("retry"); await h.click("approve");
  assert.equal(h.calls.some(c => c[0] === "redirect"), true);
  assert.equal(h.calls.some(c => c[0] === "decide"), false);
});
test("blocked WHOOP tab preserves original request and reports recovery", async () => {
  const h = setup({ blocked: true }); await h.login(); await h.click("connect");
  assert.match(h.element("message").textContent, /Allow a new tab/);
  assert.equal(h.calls.some(c => c[0] === "connect" || c[0] === "redirect"), false);
});
test("failed WHOOP start closes blank tab and leaves request retryable", async () => {
  const h = setup({ failConnect: true }); await h.login(); await h.click("connect");
  assert.equal(h.popup.closed, true);
  assert.equal(h.element("consent").hidden, true);
  assert.equal(h.element("connect").disabled, false);
});
test("connected user reaches normal consent and denial remains available", async () => {
  const h = setup({ connected: true }); await h.login();
  assert.equal(h.element("consent").hidden, false);
  await h.click("deny");
  assert.deepEqual(h.calls.find(c => c[0] === "decide"), ["decide", "pending-request", "deny"]);
});
test("returning focus rechecks server status before showing consent", async () => {
  const h = setup(); await h.login(); await h.click("connect");
  h.setConnected(true); h.win.listeners.focus(); await settle();
  assert.equal(h.element("consent").hidden, false);
});
