// Retired legacy GitHub Pages authentication client.
// WHOOP Lens authentication and MCP are hosted entirely on Cloudflare.
// Never submit credentials to the former Supabase project.
export const MCP_URL = "https://whooplens.tech/mcp";
export const AUTH_URL = "https://auth.whooplens.tech";

export function validateAuthorizationId(value) {
  if (!/^[^/?#&\\s]{1,512}$/.test(value || "")) {
    throw new Error("Invalid authorization link. Restart the connection in ChatGPT.");
  }
  return value;
}

const CHATGPT_CONNECTOR_HOSTS = new Set(["chatgpt.com"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
export function safeRedirect(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Unsafe redirect address."); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const chatgpt = CHATGPT_CONNECTOR_HOSTS.has(url.hostname) && url.protocol === "https:" && url.port === "";
  if (url.username || url.password || !(chatgpt || (loopback && ["http:", "https:"].includes(url.protocol)))) {
    throw new Error("Unsafe redirect address.");
  }
  return url.href;
}

export function createAuthClient() {
  const retired = () => { throw new Error("Legacy sign-in is retired. Connect through https://whooplens.tech/mcp using Cloudflare Access."); };
  return { signIn: retired, signOut: retired, details: retired, decide: retired, status: retired, connect: retired };
}
