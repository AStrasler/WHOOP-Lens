// Dependency-free browser client. Only the public project key belongs here.
export const SUPABASE_URL = "https://evoiwauqplbcecumiwqn.supabase.co";
export const PUBLIC_KEY = "sb_publishable_iSQO1ZdTmCnRHC_YxKb30A_x7rVRYr_";
export const MCP_URL = SUPABASE_URL + "/functions/v1/whoop-mcp";

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

export function createAuthClient(fetcher = globalThis.fetch, now = () => Date.now()) {
  // Session credentials stay in memory, never localStorage, sessionStorage, or URLs.
  let session = null;
  async function request(path, { method = "GET", body, authenticated = true } = {}) {
    if (!path.startsWith("/auth/v1/") && !path.startsWith("/functions/v1/whoop-mcp/")) {
      throw new Error("Unsupported service path.");
    }
    if (path.includes("..") || path.includes("\\") || path.includes("#")) throw new Error("Invalid service path.");
    if (authenticated && (!session || session.expiresAt <= now())) {
      session = null;
      throw new Error("Your sign-in has expired. Sign in again.");
    }
    const headers = { apikey: PUBLIC_KEY, "Content-Type": "application/json" };
    if (authenticated) headers.Authorization = "Bearer " + session.accessToken;
    const response = await fetcher(SUPABASE_URL + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) session = null;
      // Never render raw upstream responses: they may contain sensitive details.
      if (response.status === 429) throw new Error("Too many attempts. Wait a moment and try again.");
      if (path.startsWith("/functions/") && [404, 503].includes(response.status)) {
        throw new Error("The WHOOP server is not ready yet. Finish setup before linking your account.");
      }
      throw new Error(response.status === 401 ? "Sign-in expired or credentials were not accepted." :
        "This request could not be completed. Check your sign-in or restart the connection.");
    }
    return data;
  }
  return {
    async signIn(email, password) {
      session = null;
      const data = await request("/auth/v1/token?grant_type=password", {
        method: "POST", authenticated: false, body: { email, password }
      });
      if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new Error("Sign-in did not return a valid session.");
      }
      session = { accessToken: data.access_token, expiresAt: now() + data.expires_in * 1000 };
      // Do not expose access or refresh tokens to UI code.
      return { email: data.user?.email || email };
    },
    async signOut() {
      try { if (session) await request("/auth/v1/logout?scope=local", { method: "POST" }); }
      finally { session = null; }
    },
    details(id) { return request("/auth/v1/oauth/authorizations/" + validateAuthorizationId(id)); },
    decide(id, action) {
      if (!["approve", "deny"].includes(action)) throw new Error("Invalid consent action.");
      return request("/auth/v1/oauth/authorizations/" + validateAuthorizationId(id) + "/consent",
        { method: "POST", body: { action } });
    },
    status() { return request("/functions/v1/whoop-mcp/status"); },
    connect() { return request("/functions/v1/whoop-mcp/connect", { method: "POST", body: {} }); }
  };
}

