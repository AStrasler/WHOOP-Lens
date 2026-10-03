import { createAuthClient, validateAuthorizationId, safeRedirect, MCP_URL } from "./auth-client.mjs";
const byId = id => document.getElementById(id);
const auth = createAuthClient();
const params = new URLSearchParams(location.search);
const authorizationId = params.get("authorization_id");
let existingRedirect = null;
const message = (text, isError = false) => {
  byId("message").textContent = text;
  byId("message").classList.toggle("error", isError);
};
const busy = (value) => document.querySelectorAll("button").forEach(button => button.disabled = value);
const handle = async (action) => {
  busy(true); message("");
  try { await action(); } catch (error) { message(error.message, true); }
  finally { busy(false); }
};
if (window.top !== window.self) {
  document.body.textContent = "Open this page directly to sign in.";
  throw new Error("Embedding is not allowed.");
}
if (authorizationId) {
  byId("heading").textContent = "Approve an app";
  byId("intro").textContent = "Sign in to review which app is requesting access to your WHOOP integration.";
  try { validateAuthorizationId(authorizationId); }
  catch (error) { message(error.message, true); byId("login").hidden = true; }
} else if (location.pathname.includes("/oauth/consent")) {
  message("No authorization request was provided. Start the connection from ChatGPT or Codex.", true);
  byId("login").hidden = true;
}
const linkedEmail = params.get("linked_email");
const linkedAccount = linkedEmail && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(linkedEmail) && linkedEmail.length <= 254
  ? linkedEmail : "";
if (params.get("connected") === "1") {
  message(linkedAccount
    ? "WHOOP is linked to the Supabase user " + linkedAccount + ". Sign in with that account to confirm the connection."
    : "Returned from WHOOP. Sign in to check that your account is connected.");
}
byId("endpoint").textContent = MCP_URL + "/mcp";
byId("login").addEventListener("submit", event => {
  event.preventDefault();
  handle(async () => {
    const password = byId("password").value;
    byId("password").value = "";
    const user = await auth.signIn(byId("email").value.trim(), password);
    byId("login").hidden = true;
    byId("account").hidden = false;
    byId("signed-in").textContent = "Signed in as " + user.email;
    await loadSignedIn();
  });
});
async function loadSignedIn() {
  if (!authorizationId) {
    byId("connection").hidden = false;
    await checkConnection();
    return;
  }
  const details = await auth.details(authorizationId);
  byId("consent").hidden = false;
  if (!("authorization_id" in details)) {
    existingRedirect = safeRedirect(details.redirect_url);
    byId("client-name").textContent = "Previously approved app";
    byId("redirect").textContent = new URL(existingRedirect).origin;
    byId("permissions").textContent = "You previously approved this connection. Continue to return to the app.";
    byId("approve").textContent = "Continue";
    byId("deny").hidden = true;
    return;
  }
  byId("client-name").textContent = details.client?.name || "Unnamed app";
  byId("redirect").textContent = new URL(safeRedirect(details.redirect_uri)).origin;
  byId("permissions").textContent = details.scope?.trim() || "No additional identity scopes requested";
}
async function checkConnection() {
  const status = await auth.status();
  byId("connection-status").textContent = status.connected
    ? "Your WHOOP account is connected." : "Your WHOOP account is not connected yet.";
  byId("connect").textContent = status.connected ? "Reconnect WHOOP" : "Connect WHOOP";
  byId("connect").hidden = false;
}
byId("retry").addEventListener("click", () => handle(loadSignedIn));
function assignApproved(value) {
  location.assign(safeRedirect(value));
}
byId("approve").addEventListener("click", () => handle(async () => {
  const target = existingRedirect || (await auth.decide(authorizationId, "approve")).redirect_url;
  assignApproved(target);
}));
byId("deny").addEventListener("click", () => handle(async () => {
  const data = await auth.decide(authorizationId, "deny");
  assignApproved(data.redirect_url);
}));
byId("connect").addEventListener("click", () => handle(async () => {
  const data = await auth.connect();
  const url = new URL(data.authorization_url);
  if (url.username || url.password || url.protocol !== "https:" || url.origin !== "https://api.prod.whoop.com" || url.pathname !== "/oauth/oauth2/auth") {
    throw new Error("The server returned an unexpected WHOOP sign-in address.");
  }
  location.assign(url.href);
}));
byId("signout").addEventListener("click", () => handle(async () => {
  try { await auth.signOut(); } finally { location.replace(location.pathname + location.search); }
}));

