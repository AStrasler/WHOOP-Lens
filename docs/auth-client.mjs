// Retired browser authentication. Empty compatibility exports prevent legacy network access.
export const SUPABASE_URL = "";
export const PUBLIC_KEY = "";
export const MCP_URL = "https://whooplens.tech/mcp";

export function validateAuthorizationId(value) {
  if (!/^[^/?#&\s]{1,512}$/.test(value || "")) {
    throw new Error("Invalid or expired authorization link. Start again from ChatGPT or Codex.");
  }
  return value;
}

const CHATGPT_CONNECTOR_HOSTS = new Set(["chatgpt.com"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function safeRedirect(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("The app returned an unsafe redirect address."); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const chatgpt = CHATGPT_CONNECTOR_HOSTS.has(url.hostname) && url.protocol === "https:" && url.port === "";
  if (url.username || url.password || !(chatgpt || (loopback && (url.protocol === "http:" || url.protocol === "https:")))) {
    throw new Error("The app returned an unsafe redirect address.");
  }
  return url.href;
}

// Compatibility shim: legacy callers fail closed without making network requests.
export function createAuthClient() {
  const retired = async () => { throw new Error("Legacy Supabase sign-in has been retired. Connect using https://whooplens.tech/mcp instead."); };
  return {signIn: retired, signOut: retired, details: retired, decide: retired, status: retired, connect: retired};
}
