// Transitional identity verifier. Supabase remains the authority during staging.
// This is NOT the final independent Cloudflare OAuth/identity replacement.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_ORIGIN = "https://evoiwauqplbcecumiwqn.supabase.co";
const TIMEOUT_MS = 8000;

export class AccessDenied extends Error {
  constructor(status = 401) {
    super("Access denied");
    this.status = status;
  }
}

export async function verifySupabaseSession(request, env, fetcher = fetch) {
  const auth = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,8192})$/i.exec(auth);
  if (!match) throw new AccessDenied(401);
  if (!env?.SUPABASE_PUBLIC_KEY || typeof env.SUPABASE_PUBLIC_KEY !== "string")
    throw new Error("Staging identity provider not configured");
  let response;
  try {
    response = await fetcher(AUTH_ORIGIN + "/auth/v1/user", {
      method: "GET",
      headers: { Authorization: "Bearer " + match[1], apikey: env.SUPABASE_PUBLIC_KEY },
      cache: "no-store", credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new Error("Identity provider unavailable");
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new AccessDenied(401);
    throw new Error("Identity provider unavailable");
  }
  let user;
  try { user = await response.json(); }
  catch { throw new AccessDenied(401); }
  if (!user || typeof user.id !== "string" || !USER_ID.test(user.id))
    throw new AccessDenied(401);
  // Never use an identity supplied by a request query, body or header.
  // Never return the user's email or other account data.
  return user.id.toLowerCase();
}
