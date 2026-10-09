import { createAuthClient, validateAuthorizationId, safeRedirect, MCP_URL } from "./auth-client.mjs";
import { landingNote } from "./landing.mjs";
const byId = id => document.getElementById(id);
const auth = createAuthClient();
const params = new URLSearchParams(location.search);
const authorizationId = params.get("authorization_id");
let existingRedirect = null;
let signedIn = false;
let whoopWindow = null;
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
const note = landingNote(params);
if (note) message(note.text, note.error);
byId("endpoint").textContent = MCP_URL + "/mcp";
byId("login").addEventListener("submit", event => {
  event.preventDefault();
  handle(async () => {
    const password = byId("password").value;
    byId("password").value = "";
    const user = await auth.signIn(byId("email").value.trim(), password);
    signedIn = true;
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
  // Do not approve the MCP connection until this user has authorized WHOOP.
  byId("consent").hidden = true;
  const status = await auth.status();
  byId("connection").hidden = !!status.connected;
  if (!status.connected) {
    byId("connection-status").textContent = "Connect your WHOOP account first. WHOOP opens in a separate tab. After authorizing, return here and click Refresh to continue.";
    byId("connect").textContent = "Connect WHOOP";
    byId("connect").hidden = false;
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
  if (!(await auth.status()).connected) {
    await loadSignedIn();
    return;
  }
  const target = existingRedirect || (await auth.decide(authorizationId, "approve")).redirect_url;
  assignApproved(target);
}));
byId("deny").addEventListener("click", () => handle(async () => {
  const data = await auth.decide(authorizationId, "deny");
  assignApproved(data.redirect_url);
}));
byId("connect").addEventListener("click", () => {
  // Open synchronously from the click so popup blockers do not lose the request.
  // Keep the sign-in session and pending authorization in this original tab.
  const popup = authorizationId ? window.open("about:blank", "_blank") : null;
  if (authorizationId && !popup) {
    message("Allow a new tab for WHOOP sign-in, then click Connect WHOOP again. Keep this tab open.", true);
    return;
  }
  if (popup) {
    popup.opener = null;
    whoopWindow = popup;
  }
  handle(async () => {
  try {
  const data = await auth.connect();
  const url = new URL(data.authorization_url);
  if (url.username || url.password || url.protocol !== "https:" || url.origin !== "https://api.prod.whoop.com" || url.pathname !== "/oauth/oauth2/auth") {
    throw new Error("The server returned an unexpected WHOOP sign-in address.");
  }
  if (popup) {
    popup.location.replace(url.href);
    message("Complete WHOOP authorization in the new tab, then return here and click Refresh.");
  } else {
    location.assign(url.href);
  }
  } catch (error) {
    if (popup) popup.close();
    whoopWindow = null;
    throw error;
  }
  });
});
window.addEventListener("focus", () => {
  if (signedIn && authorizationId && whoopWindow) handle(loadSignedIn);
});
byId("signout").addEventListener("click", () => handle(async () => {
  try { await auth.signOut(); } finally { location.replace(location.pathname + location.search); }
}));

