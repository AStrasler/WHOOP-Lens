var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
import { WorkerEntrypoint } from "cloudflare:workers";
var OAUTH_SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
function isValidOAuthScopeToken(scopeToken) {
  return OAUTH_SCOPE_TOKEN_PATTERN.test(scopeToken);
}
__name(isValidOAuthScopeToken, "isValidOAuthScopeToken");
var version = "1.2.3";
var OUTBOUND_USER_AGENT = `workers-oauth-provider/${version} (+https://github.com/cloudflare/workers-oauth-provider)`;
function withCorsHeaders(response, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const cors = new Response(response.body, response);
  const setUnlessPresent = /* @__PURE__ */ __name((name, value) => {
    if (!cors.headers.has(name)) cors.headers.set(name, value);
  }, "setUnlessPresent");
  setUnlessPresent("Access-Control-Allow-Origin", origin);
  setUnlessPresent("Access-Control-Allow-Methods", "*");
  setUnlessPresent("Access-Control-Allow-Headers", "Authorization, *");
  setUnlessPresent("Access-Control-Max-Age", "86400");
  appendHeaderValue(cors.headers, "Vary", "Origin");
  appendHeaderValue(cors.headers, "Access-Control-Expose-Headers", "WWW-Authenticate");
  appendHeaderValue(cors.headers, "Access-Control-Expose-Headers", "Retry-After");
  return cors;
}
__name(withCorsHeaders, "withCorsHeaders");
function appendHeaderValue(headers, name, value) {
  const values = (headers.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  headers.set(name, values.join(", "));
}
__name(appendHeaderValue, "appendHeaderValue");
function resolveRequiredScopes(requiredScopes, deprecatedScopesSupported) {
  if (requiredScopes !== void 0 && deprecatedScopesSupported !== void 0) throw new TypeError("Set requiredScopes only: resourceMetadata.scopes_supported is deprecated in its favour");
  const scopes = requiredScopes ?? deprecatedScopesSupported;
  return scopes === void 0 ? void 0 : [...scopes];
}
__name(resolveRequiredScopes, "resolveRequiredScopes");
function baselineResourceScopes(scopes) {
  return [...new Set(scopes)].filter((scope) => scope !== "offline_access");
}
__name(baselineResourceScopes, "baselineResourceScopes");
var OAuthError = class extends Error {
  static {
    __name(this, "OAuthError");
  }
  constructor(code, options) {
    super(options.description);
    this.name = "OAuthError";
    this.code = code;
    this.options = {
      ...options,
      statusCode: options.statusCode ?? 400
    };
    this.description = this.options.description;
    this.statusCode = this.options.statusCode;
    this.headers = this.options.headers;
    this.requiredScopes = this.options.requiredScopes;
  }
};
var EMA_MAX_JWT_BYTES = 16 * 1024;
var EMA_JWKS_MAX_SIZE_BYTES = 64 * 1024;
var CLIENT_ASSERTION_MAX_BYTES = 16 * 1024;
function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}
__name(isLoopbackHostname, "isLoopbackHostname");
function hasAcceptedCanonicalScheme(url) {
  return url.protocol === "https:" || url.protocol === "http:" && isLoopbackHostname(url.hostname);
}
__name(hasAcceptedCanonicalScheme, "hasAcceptedCanonicalScheme");
function validateResourceUri(uri) {
  if (!uri || typeof uri !== "string") return false;
  if (!/^[\x21-\x7e]+$/.test(uri) || /["\\#]/.test(uri) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(uri) || /%(?![0-9A-Fa-f]{2})/.test(uri) || !/^[A-Za-z0-9:/?@!$&'()*+,;=._~%\[\]-]+$/.test(uri)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
__name(validateResourceUri, "validateResourceUri");
function resourceMatches(requested, granted) {
  const foldedRequested = foldResourceSchemeAndHost(requested);
  const foldedGranted = foldResourceSchemeAndHost(granted);
  if (foldedRequested === void 0 || foldedGranted === void 0) return false;
  return normalizeEmptyPath(foldedRequested) === normalizeEmptyPath(foldedGranted);
}
__name(resourceMatches, "resourceMatches");
function foldResourceSchemeAndHost(resource) {
  const schemeSeparator = resource.indexOf("://");
  if (schemeSeparator <= 0) return void 0;
  const authorityStart = schemeSeparator + 3;
  const authorityEndOffset = resource.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset === -1 ? resource.length : authorityStart + authorityEndOffset;
  const authority = resource.slice(authorityStart, authorityEnd);
  const hostStart = authority.lastIndexOf("@") + 1;
  let hostEnd;
  if (authority[hostStart] === "[") {
    const closingBracket = authority.indexOf("]", hostStart + 1);
    if (closingBracket === -1) return void 0;
    hostEnd = closingBracket + 1;
  } else {
    const portSeparator = authority.indexOf(":", hostStart);
    hostEnd = portSeparator === -1 ? authority.length : portSeparator;
  }
  const asciiLower = /* @__PURE__ */ __name((value) => value.replace(/[A-Z]/g, (character) => character.toLowerCase()), "asciiLower");
  return asciiLower(resource.slice(0, schemeSeparator)) + "://" + authority.slice(0, hostStart) + asciiLower(authority.slice(hostStart, hostEnd)) + authority.slice(hostEnd) + resource.slice(authorityEnd);
}
__name(foldResourceSchemeAndHost, "foldResourceSchemeAndHost");
function normalizeEmptyPath(resource) {
  const authorityStart = resource.indexOf("://") + 3;
  const pathOffset = resource.slice(authorityStart).search(/[/?#]/);
  if (pathOffset === -1) return `${resource}/`;
  const pathStart = authorityStart + pathOffset;
  return resource[pathStart] === "/" ? resource : `${resource.slice(0, pathStart)}/${resource.slice(pathStart)}`;
}
__name(normalizeEmptyPath, "normalizeEmptyPath");
function requestCarriesResourceQuery(requestUrl, resourceUrl) {
  for (const [name, value] of resourceUrl.searchParams) if (!requestUrl.searchParams.getAll(name).includes(value)) return false;
  return true;
}
__name(requestCarriesResourceQuery, "requestCarriesResourceQuery");
var CIMD_MAX_SIZE_BYTES = 5 * 1024;
var CIMD_CACHE_MAX_TTL_SECONDS = 10080 * 60;
var PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1 = "/.well-known/oauth-protected-resource";
var NO_CACHE_HEADERS$1 = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
};
function insufficientScope(auth, scope, description) {
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((value) => typeof value !== "string" || !isValidOAuthScopeToken(value))) throw new TypeError("insufficientScope requires at least one valid OAuth scope token");
  let challenge = `Bearer realm="OAuth", error="insufficient_scope", scope="${[...new Set(scope)].join(" ")}"`;
  challenge += `, resource_metadata="${getResourceMetadataUrl(auth.audience)}"`;
  if (description !== void 0) {
    const quotable = description.replace(/["\\]/g, "").replace(/[^\x21-\x7e]+/g, " ").trim();
    if (quotable) challenge += `, error_description="${quotable}"`;
  }
  return new Response(JSON.stringify({
    error: "insufficient_scope",
    ...description !== void 0 ? { error_description: description } : {}
  }), {
    status: 403,
    headers: {
      ...NO_CACHE_HEADERS$1,
      "Content-Type": "application/json",
      "WWW-Authenticate": challenge
    }
  });
}
__name(insufficientScope, "insufficientScope");
var OAuthResourceServer = class {
  static {
    __name(this, "OAuthResourceServer");
  }
  #options;
  #validated;
  constructor(options) {
    this.#validated = validateOptions(options);
    this.#options = options;
  }
  async fetch(request, env, ctx) {
    const options = this.#options;
    const validated = this.#validated;
    const url = new URL(request.url);
    if (isProtectedResourceMetadataPath(url)) {
      if (request.method === "OPTIONS") return withCorsHeaders(new Response(null, {
        status: 204,
        headers: { "Content-Length": "0" }
      }), request);
      if (!isMetadataUrlRequest(url, validated.metadataUrl)) return withCorsHeaders(new Response(null, { status: 404 }), request);
      if (request.method !== "GET" && request.method !== "HEAD") return withCorsHeaders(new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD, OPTIONS" }
      }), request);
      const metadata = Response.json(validated.metadata, { headers: NO_CACHE_HEADERS$1 });
      return withCorsHeaders(request.method === "HEAD" ? new Response(null, {
        status: 200,
        headers: metadata.headers
      }) : metadata, request);
    }
    if (!isCanonicalResourceRequest(url, validated.resourceUrl)) return new Response(null, { status: 404 });
    if (request.method === "OPTIONS") return withCorsHeaders(new Response(null, {
      status: 204,
      headers: { "Content-Length": "0" }
    }), request);
    const token = parseBearerToken(request.headers.get("Authorization"));
    if (!token) return withCorsHeaders(createBearerChallenge(url, validated, false), request);
    let validation;
    try {
      validation = await options.validateToken(env, request)(validated.resource, token);
    } catch (error) {
      if (error instanceof OAuthError) return withCorsHeaders(createOAuthErrorResponse(error, url, validated), request);
      return withCorsHeaders(createValidationUnavailableResponse(), request);
    }
    if (!isValidTokenValidation(validation, validated.resource)) return withCorsHeaders(createBearerChallenge(url, validated, true), request);
    const context2 = ctx;
    context2.props = validation.props;
    context2.auth = {
      token,
      audience: validated.resource,
      ...validation.expiresAt !== void 0 ? { expiresAt: validation.expiresAt } : {},
      scope: [...validation.scope ?? []],
      ...validation.userId !== void 0 ? { userId: validation.userId } : {},
      ...validation.clientId !== void 0 ? { clientId: validation.clientId } : {}
    };
    const handler = options.handler;
    return withCorsHeaders(isEntrypointClass(handler) ? await new handler(context2, env).fetch(request) : await handler.fetch(request, env, context2), request);
  }
};
function validateOptions(options) {
  if (!options || typeof options !== "object") throw new TypeError("OAuth resource server options are required");
  if (!options.handler || !isEntrypointClass(options.handler) && typeof options.handler.fetch !== "function") throw new TypeError("handler must provide a fetch function or extend WorkerEntrypoint");
  if (typeof options.validateToken !== "function") throw new TypeError("validateToken must be a function");
  const resource = options.resourceMetadata?.resource;
  const resourceUrl = parseCanonicalUrl(resource);
  if (!resourceUrl) throw new TypeError("resourceMetadata.resource must be a canonical absolute HTTPS URI without a fragment (http is accepted only on a loopback host)");
  if (isProtectedResourceMetadataPath(resourceUrl)) throw new TypeError(`resourceMetadata.resource must not be inside the ${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1} namespace`);
  const authorizationServers = options.resourceMetadata.authorization_servers;
  if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) throw new TypeError("resourceMetadata.authorization_servers must contain at least one issuer");
  for (const issuer of authorizationServers) {
    const issuerUrl = parseCanonicalUrl(issuer);
    if (!issuerUrl || issuerUrl.search || issuerUrl.hash) throw new TypeError("resourceMetadata.authorization_servers must contain canonical HTTPS issuer URLs (http is accepted only on a loopback host)");
  }
  const bearerMethods = options.resourceMetadata.bearer_methods_supported;
  if (bearerMethods !== void 0 && (bearerMethods.length !== 1 || bearerMethods[0] !== "header")) throw new TypeError("resourceMetadata.bearer_methods_supported only supports 'header'");
  const configuredScopes = resolveRequiredScopes(options.requiredScopes, options.resourceMetadata.scopes_supported) ?? [];
  if (configuredScopes.some((scope) => typeof scope !== "string" || !isValidOAuthScopeToken(scope))) throw new TypeError("requiredScopes (or the deprecated resourceMetadata.scopes_supported) must contain valid OAuth scope tokens");
  const resourceScopes = baselineResourceScopes(configuredScopes);
  return {
    resource,
    resourceUrl,
    metadataUrl: new URL(getResourceMetadataUrl(resource)),
    metadata: {
      resource,
      authorization_servers: [...authorizationServers],
      ...resourceScopes.length ? { scopes_supported: resourceScopes } : {},
      bearer_methods_supported: bearerMethods ? [...bearerMethods] : ["header"],
      ...options.resourceMetadata.resource_name !== void 0 ? { resource_name: options.resourceMetadata.resource_name } : {}
    }
  };
}
__name(validateOptions, "validateOptions");
function parseCanonicalUrl(value) {
  if (typeof value !== "string" || !validateResourceUri(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!hasAcceptedCanonicalScheme(parsed) || parsed.username || parsed.password || parsed.protocol !== parsed.protocol.toLowerCase() || parsed.hostname !== parsed.hostname.toLowerCase()) return null;
  if (parsed.href !== value && parsed.origin !== value) return null;
  return parsed;
}
__name(parseCanonicalUrl, "parseCanonicalUrl");
function getResourceMetadataUrl(resource) {
  const parsed = new URL(resource);
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1}${suffix}${parsed.search}`;
}
__name(getResourceMetadataUrl, "getResourceMetadataUrl");
function isEntrypointClass(handler) {
  return typeof handler === "function" && handler.prototype instanceof WorkerEntrypoint;
}
__name(isEntrypointClass, "isEntrypointClass");
function isProtectedResourceMetadataPath(url) {
  return url.pathname === PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1 || url.pathname.startsWith(`${PROTECTED_RESOURCE_WELL_KNOWN_PREFIX$1}/`);
}
__name(isProtectedResourceMetadataPath, "isProtectedResourceMetadataPath");
function isMetadataUrlRequest(requestUrl, metadataUrl) {
  return requestUrl.origin === metadataUrl.origin && requestUrl.pathname === metadataUrl.pathname && requestCarriesResourceQuery(requestUrl, metadataUrl);
}
__name(isMetadataUrlRequest, "isMetadataUrlRequest");
function isCanonicalResourceRequest(requestUrl, resourceUrl) {
  if (requestUrl.origin !== resourceUrl.origin) return false;
  if (!requestCarriesResourceQuery(requestUrl, resourceUrl)) return false;
  const resourcePath = resourceUrl.pathname;
  if (requestUrl.pathname === resourcePath) return true;
  if (resourcePath === "/") return requestUrl.pathname.startsWith("/");
  const descendantPrefix = resourcePath.endsWith("/") ? resourcePath : `${resourcePath}/`;
  return requestUrl.pathname.startsWith(descendantPrefix);
}
__name(isCanonicalResourceRequest, "isCanonicalResourceRequest");
function parseBearerToken(authorization) {
  if (!authorization) return null;
  return /^Bearer[\t ]+([^\s,]+)$/i.exec(authorization)?.[1] || null;
}
__name(parseBearerToken, "parseBearerToken");
function isValidTokenValidation(validation, canonicalResource) {
  if (!validation || typeof validation !== "object") return false;
  if (typeof validation.audience !== "string" || !resourceMatches(validation.audience, canonicalResource)) return false;
  if (!Object.prototype.hasOwnProperty.call(validation, "props")) return false;
  if (validation.expiresAt !== void 0) {
    if (typeof validation.expiresAt !== "number" || !Number.isFinite(validation.expiresAt)) return false;
    if (validation.expiresAt <= Date.now() / 1e3) return false;
  }
  if (validation.scope !== void 0) {
    if (!Array.isArray(validation.scope)) return false;
    if (validation.scope.some((scope) => typeof scope !== "string" || !isValidOAuthScopeToken(scope))) return false;
  }
  if (validation.userId !== void 0 && typeof validation.userId !== "string") return false;
  if (validation.clientId !== void 0 && typeof validation.clientId !== "string") return false;
  return true;
}
__name(isValidTokenValidation, "isValidTokenValidation");
function createBearerChallenge(requestUrl, validated, invalidToken) {
  let challenge = 'Bearer realm="OAuth"';
  if (isCanonicalResourceRequest(requestUrl, validated.resourceUrl)) challenge += `, resource_metadata="${validated.metadataUrl.href}"`;
  if (invalidToken) challenge += ', error="invalid_token"';
  const scopes = validated.metadata.scopes_supported;
  if (scopes && scopes.length > 0) challenge += `, scope="${scopes.join(" ")}"`;
  return new Response(null, {
    status: 401,
    headers: {
      ...NO_CACHE_HEADERS$1,
      "WWW-Authenticate": challenge
    }
  });
}
__name(createBearerChallenge, "createBearerChallenge");
function createOAuthErrorResponse(error, requestUrl, validated) {
  const headers = {
    ...NO_CACHE_HEADERS$1,
    "Content-Type": "application/json",
    ...error.headers
  };
  const hasChallenge = Object.keys(headers).some((name) => name.toLowerCase() === "www-authenticate");
  let status = error.statusCode;
  if (error.code === "invalid_token") {
    status = 401;
    if (!hasChallenge) headers["WWW-Authenticate"] = createBearerChallenge(requestUrl, validated, true).headers.get("WWW-Authenticate");
  } else if (error.code === "insufficient_scope") {
    status = 403;
    if (!hasChallenge) {
      const scopes = [...new Set(error.requiredScopes ?? validated.metadata.scopes_supported ?? [])];
      if (scopes.some((scope) => typeof scope !== "string" || !isValidOAuthScopeToken(scope))) return createValidationUnavailableResponse();
      headers["WWW-Authenticate"] = 'Bearer realm="OAuth", error="insufficient_scope"' + (scopes.length > 0 ? `, scope="${scopes.join(" ")}"` : "") + `, resource_metadata="${validated.metadataUrl.href}"`;
    }
  }
  return new Response(JSON.stringify({
    error: error.code,
    error_description: error.description
  }), {
    status,
    headers
  });
}
__name(createOAuthErrorResponse, "createOAuthErrorResponse");
function createValidationUnavailableResponse() {
  return new Response(null, {
    status: 503,
    headers: NO_CACHE_HEADERS$1
  });
}
__name(createValidationUnavailableResponse, "createValidationUnavailableResponse");
var DEFAULT_REMEMBER_SECONDS = 720 * 60 * 60;
if (!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags?.global_fetch_strictly_public === true)) console.warn(`CIMD (Client ID Metadata Document) is disabled: add '"compatibility_flags": ["global_fetch_strictly_public"]' to your wrangler.jsonc to enable. See: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public`);
var DEFAULT_REFRESH_TOKEN_TTL = 720 * 60 * 60;
var DEFAULT_CLIENT_REGISTRATION_TTL = 2160 * 60 * 60;
var TOKEN_LENGTH = 32;
var ISSUED_TOKEN_SECRET_PATTERN = /* @__PURE__ */ new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);
var WRAPPING_KEY_HMAC_KEY = new Uint8Array([
  34,
  126,
  38,
  134,
  141,
  241,
  225,
  109,
  128,
  112,
  234,
  23,
  151,
  91,
  71,
  166,
  130,
  24,
  250,
  135,
  40,
  174,
  222,
  133,
  181,
  29,
  74,
  217,
  150,
  202,
  202,
  67
]);

// ../../src/storage.mjs
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function verifiedUserId(userId) {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("Invalid verified user");
  return userId.toLowerCase();
}
__name(verifiedUserId, "verifiedUserId");
function checkD1(db) {
  if (!db || typeof db.prepare !== "function") throw new Error("Staging D1 binding missing");
}
__name(checkD1, "checkD1");
async function activeMembership(db, userId) {
  checkD1(db);
  const id = verifiedUserId(userId);
  const member = await db.prepare(
    "SELECT m.user_id FROM whoop_members m INNER JOIN identity_links i ON i.user_id=m.user_id WHERE m.user_id=?1 AND m.active=1 AND ((i.identity_provider='supabase' AND i.provider_subject=?1) OR (i.identity_provider='cloudflare_access' AND length(i.provider_subject)>0)) LIMIT 1"
  ).bind(id).first();
  return !!member;
}
__name(activeMembership, "activeMembership");
async function connectionStatus(db, userId) {
  checkD1(db);
  const id = verifiedUserId(userId);
  const row = await db.prepare(
    "SELECT seat_role FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  return { connected: !!row };
}
__name(connectionStatus, "connectionStatus");
var historyQueries = Object.freeze({
  recovery: "SELECT whoop_id,date,score,hrv,resting_heart_rate FROM whoop_recovery WHERE user_id=?1 ORDER BY date DESC, whoop_id DESC LIMIT ?2",
  sleep: "SELECT whoop_id,start_time,end_time,performance_percentage,efficiency_percentage,total_sleep_seconds,rem_sleep_seconds,slow_wave_sleep_seconds FROM whoop_sleep WHERE user_id=?1 ORDER BY start_time DESC, whoop_id DESC LIMIT ?2"
});
async function readHistory(db, userId, category, limit = 10) {
  checkD1(db);
  const id = verifiedUserId(userId);
  if (!Object.hasOwn(historyQueries, category)) throw new Error("Unsupported history category");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    throw new Error("History limit out of range");
  const result = await db.prepare(historyQueries[category]).bind(id, limit).all();
  if (result.success === false || !Array.isArray(result.results))
    throw new Error("Staging read failed");
  return result.results;
}
__name(readHistory, "readHistory");

// ../../src/access-denied.mjs
var AccessDenied = class extends Error {
  static {
    __name(this, "AccessDenied");
  }
  constructor(status = 401) {
    super("Access denied");
    this.status = status;
  }
};

// ../../src/token-crypto.mjs
var enc = new TextEncoder();
var dec = new TextDecoder();
var userPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function base64Url(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(base64Url, "base64Url");
function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid token envelope");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
__name(fromBase64Url, "fromBase64Url");
async function aesKey(encoded) {
  const bytes = fromBase64Url(encoded);
  if (bytes.length !== 32) throw Error("Cloudflare key must be 256 bits");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
__name(aesKey, "aesKey");
function context(userId, purpose) {
  if (typeof userId !== "string" || !userPattern.test(userId) || !["access", "refresh"].includes(purpose))
    throw Error("Invalid token owner or purpose");
  return enc.encode("WHOOP-Lens/Cloudflare/v1/" + userId.toLowerCase() + "/" + purpose);
}
__name(context, "context");
async function sealWhoopToken(rawToken, { userId, purpose, key }) {
  if (typeof rawToken !== "string" || rawToken.length < 1 || rawToken.length > 16384)
    throw Error("Invalid WHOOP token");
  const cipherKey = await aesKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(userId, purpose), tagLength: 128 },
    cipherKey,
    enc.encode(rawToken)
  );
  return "v1." + base64Url(iv) + "." + base64Url(new Uint8Array(ciphertext));
}
__name(sealWhoopToken, "sealWhoopToken");
async function openWhoopToken(envelope, { userId, purpose, key }) {
  if (typeof envelope !== "string" || envelope.length > 24e3) throw Error("Invalid token envelope");
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw Error("Invalid token envelope");
  const iv = fromBase64Url(parts[1]), data = fromBase64Url(parts[2]);
  if (iv.length !== 12 || data.length < 17) throw Error("Invalid token envelope");
  const cipherKey = await aesKey(key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: context(userId, purpose), tagLength: 128 },
    cipherKey,
    data
  );
  return dec.decode(plaintext);
}
__name(openWhoopToken, "openWhoopToken");

// ../../src/whoop-api.mjs
var API = "https://api.prod.whoop.com/developer/v2/";
var TOKEN_ENDPOINT = "https://api.prod.whoop.com/oauth/oauth2/token";
var resources = Object.freeze({
  profile: { path: "user/profile/basic", history: false },
  measurements: { path: "user/measurement/body", history: false },
  recovery: { path: "recovery", history: true },
  sleep: { path: "activity/sleep", history: true },
  workouts: { path: "activity/workout", history: true },
  cycles: { path: "cycle", history: true }
});
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var timeout = /* @__PURE__ */ __name(() => AbortSignal.timeout(12e3), "timeout");
function config(env) {
  if (!env || typeof env.WHOOP_TOKEN_AES256_KEY !== "string") throw Error("Token key unavailable");
  return env.WHOOP_TOKEN_AES256_KEY;
}
__name(config, "config");
function clientConfig(env) {
  if (typeof env?.WHOOP_CLIENT_ID !== "string" || !env.WHOOP_CLIENT_ID || typeof env?.WHOOP_CLIENT_SECRET !== "string" || !env.WHOOP_CLIENT_SECRET)
    throw Error("WHOOP OAuth not configured");
  return env;
}
__name(clientConfig, "clientConfig");
function ownerId(value) {
  if (typeof value !== "string" || !UUID2.test(value)) throw Error("Invalid user");
  return value.toLowerCase();
}
__name(ownerId, "ownerId");
async function boundedJson(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 2e6) throw Error("WHOOP response too large");
  const text = await response.text();
  if (text.length > 2e6) throw Error("WHOOP response too large");
  return JSON.parse(text);
}
__name(boundedJson, "boundedJson");
async function whoopAccessToken(db, userId, env, { fetcher = fetch, now = Date.now } = {}) {
  const id = ownerId(userId), key = config(env);
  if (!await activeMembership(db, id)) throw Error("Membership required");
  const row = await db.prepare(
    "SELECT encrypted_access_token,encrypted_refresh_token,expires_at,scope FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  if (!row) throw Error("WHOOP connection required");
  const currentExpiry = Date.parse(row.expires_at);
  if (Number.isFinite(currentExpiry) && currentExpiry > now() + 6e4)
    return openWhoopToken(row.encrypted_access_token, { userId: id, purpose: "access", key });
  clientConfig(env);
  const refresh = await openWhoopToken(row.encrypted_refresh_token, { userId: id, purpose: "refresh", key });
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET
  });
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
    signal: timeout()
  });
  if (!response.ok) throw Error("WHOOP refresh failed");
  const tokens = await boundedJson(response);
  if (typeof tokens?.access_token !== "string" || tokens.access_token.length < 1 || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) < 60 || Number(tokens.expires_in) > 31536e3 || tokens.refresh_token != null && typeof tokens.refresh_token !== "string")
    throw Error("Invalid WHOOP refresh response");
  const nextRefresh = tokens.refresh_token || refresh;
  const nextAccessEnvelope = await sealWhoopToken(tokens.access_token, { userId: id, purpose: "access", key });
  const nextRefreshEnvelope = await sealWhoopToken(nextRefresh, { userId: id, purpose: "refresh", key });
  const expiresAt = new Date(now() + Number(tokens.expires_in) * 1e3).toISOString();
  const result = await db.prepare(
    "UPDATE whoop_connections SET encrypted_access_token=?1,encrypted_refresh_token=?2,expires_at=?3,scope=?4,updated_at=CURRENT_TIMESTAMP WHERE user_id=?5 AND encrypted_refresh_token=?6"
  ).bind(
    nextAccessEnvelope,
    nextRefreshEnvelope,
    expiresAt,
    typeof tokens.scope === "string" ? tokens.scope : row.scope || "",
    id,
    row.encrypted_refresh_token
  ).run();
  if (!result.success || result.meta?.changes !== 1) throw Error("WHOOP refresh raced or failed");
  return tokens.access_token;
}
__name(whoopAccessToken, "whoopAccessToken");
async function callWhoop(db, userId, resource, env, opts = {}, deps = {}) {
  const spec = Object.hasOwn(resources, resource) ? resources[resource] : null;
  if (!spec) throw Error("Unsupported WHOOP resource");
  const limit = opts.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw Error("Invalid limit");
  const nextToken = opts.next_token;
  if (nextToken != null && (!spec.history || typeof nextToken !== "string" || (!/^[A-Za-z0-9._~+/-]{1,512}$/.test(nextToken) || nextToken.includes(".."))))
    throw Error("Invalid WHOOP cursor");
  const token = await whoopAccessToken(db, userId, env, deps);
  const search = new URLSearchParams();
  if (spec.history) {
    search.set("limit", String(limit));
    if (nextToken) search.set("nextToken", nextToken);
  }
  const url = API + spec.path + (search.size ? "?" + search : "");
  const response = await (deps.fetcher || fetch)(url, {
    method: "GET",
    headers: { authorization: "Bearer " + token, "accept": "application/json" },
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
    signal: timeout()
  });
  if (!response.ok) throw Error("WHOOP API request failed");
  const data = await boundedJson(response);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("WHOOP response invalid");
  return data;
}
__name(callWhoop, "callWhoop");

// ../../src/whoop-oauth.mjs
var AUTH = "https://api.prod.whoop.com/oauth/oauth2/auth";
var TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";
var REDIRECT = "https://whooplens.tech/api/whoop/callback";
var SCOPES = "offline read:profile read:body_measurement read:recovery read:sleep read:workout read:cycles";
var UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ALNUM = /^[A-Za-z0-9_-]{32,512}$/;
var NOW = /* @__PURE__ */ __name(() => Date.now(), "NOW");
var decoder = new TextDecoder();
function requireConfig(env) {
  if (!env?.WHOOP_CLIENT_ID || !env?.WHOOP_CLIENT_SECRET || !env?.WHOOP_TOKEN_AES256_KEY)
    throw Error("WHOOP OAuth credentials not configured");
  if (env.WHOOP_REDIRECT_URI !== REDIRECT)
    throw Error("WHOOP redirect not configured for approved domain");
  return env;
}
__name(requireConfig, "requireConfig");
function validateUser(userId) {
  if (typeof userId !== "string" || !UUID3.test(userId)) throw Error("Invalid user");
  return userId.toLowerCase();
}
__name(validateUser, "validateUser");
function tokenString(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(tokenString, "tokenString");
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
async function safeJson(response) {
  const raw = await response.text();
  if (raw.length > 16384) throw Error("WHOOP token response too large");
  return JSON.parse(raw);
}
__name(safeJson, "safeJson");
async function createWhoopAuthorization(db, userId, env, { now = NOW } = {}) {
  requireConfig(env);
  const id = validateUser(userId);
  if (!await activeMembership(db, id)) throw Error("Membership required");
  const state = tokenString(), expires_at = new Date(now() + 10 * 6e4).toISOString();
  const hash = await sha256(state);
  const saved = await db.prepare(
    "INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES(?1,?2,?3)"
  ).bind(hash, id, expires_at).run();
  if (!saved?.success || saved.meta?.changes !== 1) throw Error("WHOOP authorization state unavailable");
  const params = new URLSearchParams({
    client_id: env.WHOOP_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES,
    state
  });
  return { authorization_url: AUTH + "?" + params };
}
__name(createWhoopAuthorization, "createWhoopAuthorization");
async function acceptWhoopCallback(db, callback, env, { fetcher = fetch, now = NOW } = {}) {
  requireConfig(env);
  const url = callback instanceof URL ? callback : new URL(callback);
  if (url.origin !== "https://whooplens.tech" || url.pathname !== "/api/whoop/callback")
    throw Error("Unexpected callback origin");
  if (url.searchParams.has("error")) throw Error("WHOOP authorization declined");
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (typeof state !== "string" || !ALNUM.test(state) || typeof code !== "string" || code.length < 4 || code.length > 4096 || !/^[A-Za-z0-9._~+/-]+$/.test(code))
    throw Error("Invalid WHOOP callback");
  const row = await db.prepare(
    "DELETE FROM whoop_oauth_states WHERE state_hash=?1 AND expires_at>?2 RETURNING user_id"
  ).bind(await sha256(state), new Date(now()).toISOString()).first();
  if (!row?.user_id) throw Error("Invalid or expired WHOOP state");
  const id = validateUser(row.user_id);
  if (!await activeMembership(db, id)) throw Error("Membership required");
  const existing = await db.prepare("SELECT seat_role FROM whoop_connections WHERE user_id=?1").bind(id).first();
  const role = existing?.seat_role || (id === env.WHOOP_LENS_DEVELOPER_USER_ID ? "developer" : "public");
  const response = await fetcher(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.WHOOP_CLIENT_ID,
      client_secret: env.WHOOP_CLIENT_SECRET,
      redirect_uri: REDIRECT
    }),
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(12e3)
  });
  if (!response.ok) throw Error("WHOOP token exchange failed");
  const data = await safeJson(response);
  if (typeof data?.access_token !== "string" || !data.access_token || typeof data?.refresh_token !== "string" || !data.refresh_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) < 60 || Number(data.expires_in) > 31536e3)
    throw Error("Invalid WHOOP token response");
  const key = env.WHOOP_TOKEN_AES256_KEY;
  const access = await sealWhoopToken(data.access_token, { userId: id, purpose: "access", key });
  const refresh = await sealWhoopToken(data.refresh_token, { userId: id, purpose: "refresh", key });
  const expiresAt = new Date(now() + Number(data.expires_in) * 1e3).toISOString();
  const saved = await db.prepare(
    "INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?1,?2,?3,?4,?5,'v1',?6) ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,scope=excluded.scope,encrypted_access_token=excluded.encrypted_access_token,encrypted_refresh_token=excluded.encrypted_refresh_token,updated_at=CURRENT_TIMESTAMP"
  ).bind(id, expiresAt, typeof data.scope === "string" ? data.scope : "", access, refresh, role).run();
  if (!saved?.success || saved.meta?.changes !== 1) throw Error("WHOOP connection save failed");
  return { connected: true, seat_role: role };
}
__name(acceptWhoopCallback, "acceptWhoopCallback");

// ../../../supabase/functions/whoop-mcp/capabilities.json
var capabilities_default = {
  schema_version: 1,
  registry_version: "1.2.0-pr1",
  global_limitations: [
    "Measurements and patterns are not diagnoses or proofs of causation.",
    "No record is never proof of no symptoms or activity.",
    "Only current authorized account data may be read.",
    "Charts and research depend on the connected AI client.",
    "No automatic WHOOP setting changes or healthcare provider contact.",
    "Android Health Connect and medical-context integrations are planned, not live.",
    "The official WHOOP developer API does not provide Stress Monitor zone durations. Do not infer them from strain, heart rate, or HRV."
  ],
  capabilities: [
    {
      id: "profile",
      name: "WHOOP profile",
      category: "whoop",
      description: "WHOOP profile",
      provides: "WHOOP profile",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_profile"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Snapshot only; values may be missing.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Show my WHOOP profile."
      ]
    },
    {
      id: "body",
      name: "Body measurements",
      category: "whoop",
      description: "Body measurements",
      provides: "Body measurements",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_body_measurements"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Static measurements are not trends.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Show my WHOOP body measurements."
      ]
    },
    {
      id: "recovery",
      name: "Recovery, HRV and resting HR",
      category: "whoop",
      description: "Recovery, HRV and resting HR",
      provides: "Recovery, HRV and resting HR",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_recovery"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Missing/unscored days; not a diagnosis.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Chart my recovery this week."
      ]
    },
    {
      id: "sleep",
      name: "Sleep and consistency",
      category: "whoop",
      description: "Sleep and consistency",
      provides: "Sleep and consistency",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_sleep"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Nap and time zone coverage may vary.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Explore my sleep stages and consistency."
      ]
    },
    {
      id: "cycles",
      name: "Daily cycles and strain",
      category: "whoop",
      description: "Daily cycles and strain",
      provides: "Daily cycles and strain",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_cycles"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Open cycles are incomplete.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Compare my strain and recovery."
      ]
    },
    {
      id: "workouts",
      name: "Workouts and activity",
      category: "whoop",
      description: "Workouts and activity",
      provides: "Workouts and activity",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_workouts"
      ],
      data_requirements: [
        "Connected WHOOP account and relevant data"
      ],
      limitations: [
        "Missing workouts do not imply inactivity.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "Show my recent workouts and strain."
      ]
    },
    {
      id: "samsung",
      name: "Samsung Health uploads",
      category: "optional",
      description: "Samsung Health uploads",
      provides: "Samsung Health uploads",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_samsung_health"
      ],
      data_requirements: [
        "Prior authorized Samsung Health uploads"
      ],
      limitations: [
        "Only separately uploaded Samsung SDK records; no live phone sync.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "What Samsung records were uploaded?"
      ]
    },
    {
      id: "directory",
      name: "Discover capabilities",
      category: "explore",
      description: "Discover capabilities",
      provides: "Discover capabilities",
      delivery: "mcp_data",
      status: "available",
      tools: [
        "get_capabilities"
      ],
      data_requirements: [
        "Signed-in WHOOP Lens account"
      ],
      limitations: [
        "A feature list does not imply this user has records.",
        "Measurements do not establish medical diagnoses or causality."
      ],
      example_prompts: [
        "What can WHOOP Lens do?"
      ]
    },
    {
      id: "patterns",
      name: "Explore possible cross-metric patterns",
      category: "explore",
      description: "Compare dated sleep, recovery and cycle metrics when available.",
      provides: "User-directed pattern questions.",
      delivery: "host_assisted",
      status: "available",
      tools: [
        "get_recovery",
        "get_sleep",
        "get_cycles"
      ],
      data_requirements: [
        "Overlapping authorized dated WHOOP measurements"
      ],
      limitations: [
        "Correlations do not prove a cause.",
        "Too few aligned days can prevent meaningful comparisons."
      ],
      example_prompts: [
        "What patterns might I not know to ask about?"
      ]
    },
    {
      id: "charts",
      name: "Optional in-chat charts",
      category: "explore",
      description: "Charts when the connected AI client supports them; text otherwise.",
      provides: "Visual pattern explanations.",
      delivery: "host_assisted",
      status: "available",
      tools: [
        "get_recovery",
        "get_sleep"
      ],
      data_requirements: [
        "Relevant records",
        "Client-side chart support"
      ],
      limitations: [
        "The MCP cannot force the host to render a chart.",
        "A user can opt out of visuals."
      ],
      example_prompts: [
        "Chart my sleep and recovery.",
        "Skip charts."
      ]
    },
    {
      id: "advocacy",
      name: "Healthcare self-advocacy questions",
      category: "advocacy",
      description: "Help users express their own medical questions and concerns.",
      provides: "Editable patient-led appointment questions.",
      delivery: "host_assisted",
      status: "available",
      tools: [],
      data_requirements: [
        "The user's own questions and context"
      ],
      limitations: [
        "No diagnosis or judgment that a provider is wrong.",
        "No unsolicited clinician contact or advice to change treatment."
      ],
      example_prompts: [
        "Help me ask about an unresolved concern."
      ]
    },
    {
      id: "visit-brief",
      name: "Provider-ready appointment brief",
      category: "advocacy",
      description: "Prepare a user-reviewed, copyable summary for appointments.",
      provides: "Patient-led visit notes with distinct source labels.",
      delivery: "host_assisted",
      status: "available",
      tools: [],
      data_requirements: [
        "User-provided notes; optionally connected WHOOP measurements"
      ],
      limitations: [
        "No automatic provider messaging.",
        "No direct Epic, MyChart or Oracle Health integration."
      ],
      example_prompts: [
        "Make an appointment brief in my own words."
      ]
    },
    {
      id: "research",
      name: "Explain medical research",
      category: "advocacy",
      description: "Explain evidence where the AI host can retrieve verifiable sources.",
      provides: "Plain-language medical context, not clinical conclusions.",
      delivery: "host_assisted",
      status: "available",
      tools: [],
      data_requirements: [
        "User question",
        "Host research access to verify citations"
      ],
      limitations: [
        "MCP does not browse medical literature.",
        "Never invent studies, diagnoses or causal conclusions."
      ],
      example_prompts: [
        "Explain this clinical term and cite studies you can verify."
      ]
    },
    {
      id: "health-connect",
      name: "Health Connect phone sync",
      category: "planned",
      description: "Private Android Health Connect imports.",
      provides: "Not shipped.",
      delivery: "planned",
      status: "planned",
      tools: [],
      data_requirements: [
        "Future Android companion and permissions"
      ],
      limitations: [
        "Not yet implemented."
      ],
      example_prompts: []
    },
    {
      id: "medical-context",
      name: "Private medical context",
      category: "planned",
      description: "Optional patient-reviewed imported medical details.",
      provides: "Not shipped.",
      delivery: "planned",
      status: "planned",
      tools: [],
      data_requirements: [
        "Future approved importer and MCP tools"
      ],
      limitations: [
        "Not yet implemented; no EHR data read."
      ],
      example_prompts: []
    },
    {
      id: "ehr-writeback",
      name: "Direct hospital network integration",
      category: "unsupported",
      description: "Automatic uploads or writes into hospital portals.",
      provides: "Not supported.",
      delivery: "unsupported",
      status: "unsupported",
      tools: [],
      data_requirements: [
        "Separate vendor-specific authorization and implementation"
      ],
      limitations: [
        "No direct hospital network access or writes.",
        "Preparing a briefing does not send it."
      ],
      example_prompts: []
    },
    {
      id: "stress-summary-note",
      name: "User-provided stress summary",
      category: "explore",
      description: "Read a Stress Trends summary the user pastes from the WHOOP app. This is not a synced Stress Monitor feed.",
      provides: "A labeled comparison of that user-supplied summary with authorized recovery, sleep, and strain.",
      delivery: "host_assisted",
      status: "available",
      tools: [],
      data_requirements: [
        "A summary the user chooses to paste",
        "Optional connected recovery, sleep, or cycle data kept as a separate source"
      ],
      limitations: [
        "Not synced WHOOP Stress Monitor data, and this tool does not store the paste.",
        "Cannot calculate non-activity high-stress hours from strain, heart rate, or HRV."
      ],
      example_prompts: [
        "Here is my WHOOP stress summary. Label it as user-provided and compare it only with my recovery and sleep."
      ]
    },
    {
      id: "stress-monitor",
      name: "WHOOP Stress Monitor history",
      category: "unsupported",
      description: "Daily low, medium, and high physiological stress durations, including non-activity high stress.",
      provides: "Not available from the official WHOOP developer API.",
      delivery: "unsupported",
      status: "unsupported",
      tools: [],
      data_requirements: [
        "An official WHOOP Stress Monitor endpoint, which the public developer API does not provide"
      ],
      limitations: [
        "No stress-zone timeline or high-stress duration totals are returned.",
        "Strain, average heart rate, and HRV must not be converted into stress hours."
      ],
      example_prompts: []
    }
  ]
};

// ../../src/extra-tools.mjs
var SAMSUNG_METRICS = ["sleep", "heart_rate", "spo2", "steps", "activity", "exercise", "body_composition", "skin_temperature", "energy_score", "blood_pressure", "profile"];
var HC_METRICS = ["steps_daily", "sleep_session", "heart_rate", "exercise_session"];
var categories = ["whoop", "optional", "explore", "advocacy", "planned", "unsupported"];
var paging = { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 1e5 } };
var definitions = [
  ["get_samsung_health", "Read the signed-in account\u2019s uploaded Samsung Health records, separately attributed from WHOOP.", { ...paging, metric: { type: "string", enum: SAMSUNG_METRICS } }],
  ["get_health_connect", "Read the signed-in account\u2019s imported Health Connect records. This tool does not sync a phone.", { ...paging, metric: { type: "string", enum: HC_METRICS } }],
  ["get_medical_context", "Read only explicitly reviewed, source-labeled medical context belonging to the signed-in account.", paging],
  ["get_capabilities", "Describe registered tools, account data availability and limitations.", {
    category: { type: "string", enum: categories },
    limit: { type: "integer", minimum: 1, maximum: 25 },
    offset: { type: "integer", minimum: 0, maximum: 1e3 },
    include_planned: { type: "boolean" }
  }],
  ["connect_whoop", "Create a short-lived WHOOP consent link for the signed-in account. Requires user completion.", {}]
];
var extraTools = definitions.map(([name, description, properties]) => ({
  name,
  description,
  inputSchema: { type: "object", properties, additionalProperties: false },
  annotations: { readOnlyHint: name !== "connect_whoop", destructiveHint: false, openWorldHint: name === "connect_whoop" }
}));
function extraArguments(name, args) {
  const tool = extraTools.find((t) => t.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const schema = tool.inputSchema.properties;
  if (Object.keys(args).some((k) => !Object.hasOwn(schema, k))) return null;
  for (const [key, value] of Object.entries(args)) {
    const rule = schema[key];
    if (rule.type === "integer" && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) return null;
    if (rule.type === "boolean" && typeof value !== "boolean") return null;
    if (rule.enum && !rule.enum.includes(value)) return null;
  }
  return name === "connect_whoop" ? {} : { limit: 25, offset: 0, ...args };
}
__name(extraArguments, "extraArguments");
async function rows(db, sql, args) {
  const result = await db.prepare(sql).bind(...args).all();
  if (result.success === false || !Array.isArray(result.results)) throw Error("Record read unavailable");
  return result.results;
}
__name(rows, "rows");
async function readExtraTool(db, userId, name, args) {
  if (!await activeMembership(db, userId)) throw Error("Not authorized");
  if (extraArguments(name, args) === null) throw Error("Invalid arguments");
  if (name === "get_capabilities") return catalog(db, userId, args);
  const { limit = 25, offset = 0, metric } = args;
  const filter = metric === void 0 ? "" : " AND metric=?4";
  let sql;
  if (name === "get_samsung_health") sql = "SELECT metric,source,transport,observed_at,exported_at,sdk_record_json,inserted_at FROM samsung_health_records WHERE user_id=?1" + filter + " ORDER BY inserted_at DESC,id DESC LIMIT ?2 OFFSET ?3";
  else if (name === "get_health_connect") sql = "SELECT metric,record_key,origin_package,observed_at,ended_at,local_date,unit,payload_json,created_at,updated_at FROM health_connect_records WHERE user_id=?1" + filter + " ORDER BY observed_at DESC,record_key DESC LIMIT ?2 OFFSET ?3";
  else if (name === "get_medical_context") sql = "SELECT id,category,detail_json,source_type,source_label,source_date,reviewed_at,created_at,updated_at FROM medical_context WHERE user_id=?1 AND reviewed_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3";
  else throw Error("Unsupported tool");
  const data = await rows(db, sql, [userId, limit + 1, offset, ...metric === void 0 ? [] : [metric]]);
  const records = data.slice(0, limit).map((row) => {
    const result = { ...row };
    for (const [column, target] of [["sdk_record_json", "sdk_record"], ["payload_json", "payload"], ["detail_json", "detail_json"]]) {
      if (Object.hasOwn(result, column)) {
        const value = JSON.parse(result[column]);
        delete result[column];
        result[target] = value;
      }
    }
    return result;
  });
  const next_offset = data.length > limit ? offset + limit : null;
  if (name === "get_medical_context") return { entries: records, next_offset, provenance: "user_approved_medical_context" };
  return {
    records,
    next_offset,
    source: name === "get_samsung_health" ? "samsung_health" : "health_connect",
    transport: name === "get_samsung_health" ? "samsung_health_data_sdk" : "health_connect_companion"
  };
}
__name(readExtraTool, "readExtraTool");
async function catalog(db, userId, { category, limit = 25, offset = 0, include_planned = true }) {
  const connected = (await connectionStatus(db, userId)).connected;
  const available = {};
  for (const [id, sql] of Object.entries({
    samsung: "SELECT id FROM samsung_health_records WHERE user_id=?1 LIMIT 1",
    "health-connect": "SELECT id FROM health_connect_records WHERE user_id=?1 LIMIT 1",
    "medical-context": "SELECT id FROM medical_context WHERE user_id=?1 AND reviewed_at IS NOT NULL LIMIT 1"
  })) available[id] = !!await db.prepare(sql).bind(userId).first();
  const localTools = { "samsung": "get_samsung_health", "health-connect": "get_health_connect", "medical-context": "get_medical_context" };
  const capabilities = capabilities_default.capabilities.map((item) => {
    let value = { ...item };
    if (localTools[item.id]) return {
      ...value,
      category: "optional",
      delivery: "mcp_tool",
      tools: [localTools[item.id]],
      status: available[item.id] ? "available" : "requires_connection_or_data",
      provides: "Reads existing authorized records; does not import or sync new data.",
      limitations: ["Records are source-labeled and account-scoped. No automatic phone sync or EHR import."],
      availability_reason: available[item.id] ? "Authorized records exist." : "No authorized records are present for this account."
    };
    const needsWhoop = item.tools.some((t) => ["get_profile", "get_body_measurements", "get_recovery", "get_sleep", "get_workouts", "get_cycles"].includes(t));
    return {
      ...value,
      status: needsWhoop && !connected ? "requires_connection_or_data" : item.status,
      availability_reason: needsWhoop && !connected ? "Connect WHOOP first." : item.delivery === "host_assisted" ? "Depends on the AI host and sufficient user-provided or connected data." : item.status === "planned" || item.status === "unsupported" ? "Not provided by this service." : "Registered; record completeness is not guaranteed."
    };
  }).filter((item) => (!category || item.category === category) && (include_planned || !["planned", "unsupported"].includes(item.status)));
  return {
    schema_version: capabilities_default.schema_version,
    registry_version: "cloudflare-1.2",
    source: "bundled_cloudflare_catalog",
    global_limitations: [
      ...capabilities_default.global_limitations.filter((s) => !s.startsWith("Android Health Connect")),
      "Local record tools read authorized imports only; automatic imports and sync are not enabled."
    ],
    total: capabilities.length,
    next_offset: offset + limit < capabilities.length ? offset + limit : null,
    capabilities: capabilities.slice(offset, offset + limit)
  };
}
__name(catalog, "catalog");

// ../../src/host-instructions.mjs
var instructions = "WHOOP Lens covers six WHOOP categories: recovery, sleep, cycles, workouts, body measurements, and profile. It can also read separately attributed Samsung Health records when the Android companion has uploaded them; for a broad request to understand everything, call get_samsung_health as well and state clearly if no Samsung records are uploaded. For a broad request to understand all available WHOOP data, retrieve all six; paginate each of the four history categories independently until complete is true, or state exactly which categories remain incomplete. Treat complete and next_token as internal pagination fields: never show raw status labels such as `complete: true` to the user. Describe the coverage in plain language, such as all available pages through this connection, and explain any partial retrieval. Present a concise multi-domain view in chat: recovery and HRV/resting heart rate; sleep duration, timing and stages; cycle strain and steps; workout frequency/type/strain; and body measurements/profile as snapshots. Compare dated trends and overlaps, distinguish naps and open cycles from completed days, and identify missing or nonmatching dates. For any request to explain or understand ALL WHOOP data, do not finalize after retrieving WHOOP alone. If the user has connected ChatGPT Health sources available to this conversation, call the Health connection in this request and check relevant dated records before answering; prior chat text or memory is not a substitute for a current Health lookup. Do not assume Apple Health is the only wearable source. Check for both Apple Health and Health Connect coverage when the Health connection exposes them, and use whichever sources are actually available for the signed-in user. If only one is available, say which source was checked; if Health Connect is not exposed through ChatGPT Health, say so instead of treating Apple Health as the default or as proof that no Android health data exists. Then include a Health context section covering relevant records across sleep, recovery, heart metrics, activity and body measurements. Keep Health records separate from WHOOP and never send Health details to this WHOOP server. If Health is unavailable, inaccessible, or the user declines its use, state that the WHOOP retrieval is complete but the combined Health interpretation is incomplete, with the specific reason. For narrower interpretation requests, consult Health when relevant and accessible. Separate measurements, Health context, hypotheses and unknowns; do not turn correlation or a static profile value into a cause or measured trend. WHOOP Lens is read-only and cannot change WHOOP settings. When a user asks to change a WHOOP setting, goal, alarm, plan, profile value, or other configuration, clearly say that WHOOP Lens cannot make the change, direct the user to the WHOOP app, and give concise how-to steps for the relevant setting. For sleep-goal requests, use current WHOOP app guidance: on the Home screen, open Tonight's Sleep to reach Sleep Planner; for weekly sleep targets, open My Plan/View My Plan and edit the plan. If the exact in-app path is uncertain or may vary by app version, say so rather than inventing one.";
var discoveryGuidance = [
  "For 'What can WHOOP Lens do?', 'What patterns could I explore?', 'Surprise me with possible analyses', or 'What are your limitations?', call get_capabilities first. Display categorized abilities with honest availability, data requirements, limitations, and example user questions. Never claim a planned or unavailable feature is installed; the MCP tool inventory, not the newest GitHub document, determines live tools.",
  "For a capability demo, fetch a small recent signed-in-user sample with the available read-only data tools, present dates and units, and offer useful questions the user can choose. Do not crawl full history by default. Make native in-chat charts the default where the AI host supports them and enough measurements exist; always include readable text and stop charts immediately when the user opts out for the conversation. WHOOP Lens cannot draw charts or guarantee host UI.",
  "Encourage user-led investigation, flexible detail and corrections. Distinguish user statements, measured WHOOP data, optional authorized medical context, independently verifiable external research, interpretation, and uncertainty. Never invent studies or imply a correlation proves causality. Explain when the AI host cannot browse or support a chart.",
  "For healthcare self-advocacy when requested, help the user create optional clear questions and short scripts for communicating concerns, or an editable provider-ready one-page appointment brief with dated source labels. Help them raise potentially overlooked context without judging a provider, diagnosing, suggesting treatment changes, or contacting anyone. No EHR integration or automatic clinical record sharing.",
  "When users ask for medical context, explain evidence and limitations without diagnosing; they make their own decisions. Do not presume preferences from age or relationship; let each user choose technical detail, pacing, visual density and direction. Do not claim preferences persist between unrelated sessions.",
  "WHOOP Stress Monitor history is not in the official WHOOP developer API. There is no measurement of low, medium, or high stress-zone duration, non-activity high stress, or a Stress Monitor timeline. Do not estimate those durations from cycle strain, average heart rate, HRV, resting heart rate, or workouts. Say that the official API does not provide this data. If the user pastes their own Stress Trends summary, label it user-provided, keep it separate from synced WHOOP measurements, and do not store it."
].join(" ");
var hostInstructions = instructions + " " + discoveryGuidance;
var serverInfo = Object.freeze({ name: "whoop-lens", version: "1.0.0" });

// ../../src/mcp.mjs
var PROTOCOL_CURRENT = "2026-07-28";
var PROTOCOL_LEGACY = "2025-11-25";
var PROTOCOL_CHATGPT_2025_06 = "2025-06-18";
var PROTOCOL_CHATGPT_2025_03 = "2025-03-26";
var protocolVersions = /* @__PURE__ */ new Set([
  PROTOCOL_CURRENT,
  PROTOCOL_LEGACY,
  PROTOCOL_CHATGPT_2025_06,
  PROTOCOL_CHATGPT_2025_03
]);
var initializeVersions = /* @__PURE__ */ new Set([PROTOCOL_LEGACY, PROTOCOL_CHATGPT_2025_06, PROTOCOL_CHATGPT_2025_03]);
var toolToResource = Object.freeze({
  get_profile: "profile",
  get_body_measurements: "measurements",
  get_recovery: "recovery",
  get_sleep: "sleep",
  get_workouts: "workouts",
  get_cycles: "cycles"
});
var historyTools = /* @__PURE__ */ new Set(["get_recovery", "get_sleep", "get_workouts", "get_cycles"]);
var schemaNoArgs = Object.freeze({ type: "object", properties: {}, additionalProperties: false });
var schemaHistory = Object.freeze({
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 25 },
    next_token: { type: "string", minLength: 1, maxLength: 512 },
    auto_page: { type: "boolean", description: "Fetch up to four WHOOP pages (100 records maximum)" }
  },
  additionalProperties: false
});
var toolLabels = Object.freeze({
  get_profile: "Read the signed-in user's WHOOP profile.",
  get_body_measurements: "Read the signed-in user's WHOOP body measurements.",
  get_recovery: "Read the signed-in user's WHOOP recovery history.",
  get_sleep: "Read the signed-in user's WHOOP sleep history.",
  get_workouts: "Read the signed-in user's WHOOP workout history.",
  get_cycles: "Read the signed-in user's WHOOP cycle history."
});
var mcpTools = Object.freeze([...Object.keys(toolToResource).map((name) => ({
  name,
  description: toolLabels[name],
  inputSchema: historyTools.has(name) ? schemaHistory : schemaNoArgs,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
})), ...extraTools]);
var toolsByName = new Map(mcpTools.map((x) => [x.name, x]));
var own = /* @__PURE__ */ __name((x, p) => Object.prototype.hasOwnProperty.call(x, p), "own");
function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
__name(isObject, "isObject");
function fail(code, message, id) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
__name(fail, "fail");
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
__name(ok, "ok");
function toolError(id, message, modern) {
  const result = { content: [{ type: "text", text: message }], isError: true };
  if (modern) result.resultType = "complete";
  return ok(id, result);
}
__name(toolError, "toolError");
function checkArguments(name, args) {
  if (!isObject(args)) return null;
  if (extraTools.some((t) => t.name === name)) return extraArguments(name, args);
  const history = historyTools.has(name);
  if (Object.keys(args).some((k) => !(history && ["limit", "next_token", "auto_page"].includes(k)))) return null;
  if (!history) return Object.keys(args).length === 0 ? {} : null;
  const limit = args.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) return null;
  if (args.auto_page != null && typeof args.auto_page !== "boolean") return null;
  if (args.next_token != null && (typeof args.next_token !== "string" || args.next_token.length < 1 || args.next_token.length > 512 || !/^[A-Za-z0-9._~+/-]+$/.test(args.next_token) || args.next_token.includes(".."))) return null;
  if (args.auto_page === true && args.next_token != null) return null;
  return { limit, next_token: args.next_token ?? null, auto_page: args.auto_page ?? false };
}
__name(checkArguments, "checkArguments");
function validateMcpTransport(request, message) {
  if (!isObject(message)) return { status: 400, error: "Invalid MCP request" };
  const version2 = request.headers.get("mcp-protocol-version");
  if (version2 != null && !protocolVersions.has(version2))
    return { status: 400, error: "Unsupported MCP protocol version" };
  const modern = version2 === PROTOCOL_CURRENT;
  if (modern) {
    const method = request.headers.get("mcp-method");
    if (method !== message?.method) return { status: 400, error: "MCP method header mismatch" };
    const name = request.headers.get("mcp-name");
    if (message.method === "tools/call") {
      if (typeof message.params?.name !== "string" || name !== message.params.name)
        return { status: 400, error: "MCP tool header mismatch" };
    } else if (name != null) return { status: 400, error: "Unexpected MCP tool header" };
  }
  return { version: version2 || PROTOCOL_LEGACY, modern };
}
__name(validateMcpTransport, "validateMcpTransport");
async function handleMcpRpc(message, { db, userId, env, whoopRequest, whoopAuthorize }, transport) {
  const modern = transport.modern;
  if (!isObject(message) || message.jsonrpc !== "2.0")
    return fail(-32600, "Invalid JSON-RPC request", null);
  const id = message.id;
  if (!own(message, "id")) {
    return null;
  }
  if (!(typeof id === "string" || Number.isSafeInteger(id) || id === null) || typeof id === "string" && id.length > 120)
    return fail(-32600, "Invalid JSON-RPC request", null);
  if (typeof message.method !== "string") return fail(-32600, "Invalid JSON-RPC request", id);
  if (!isObject(message.params) && message.params !== void 0)
    return fail(-32602, "Invalid parameters", id);
  const params = message.params || {};
  if (message.method === "initialize") {
    if (modern) return fail(-32601, "Method not available for stateless MCP", id);
    if (!isObject(params.clientInfo) || !isObject(params.capabilities) || typeof params.protocolVersion !== "string" || !initializeVersions.has(params.protocolVersion))
      return fail(-32602, "Unsupported or invalid initialize request", id);
    return ok(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo,
      instructions: hostInstructions
    });
  }
  if (message.method === "server/discover") {
    if (!modern) return fail(-32601, "Method not found", id);
    return ok(id, {
      resultType: "complete",
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: "private",
      serverInfo,
      instructions: hostInstructions
    });
  }
  if (message.method === "ping") return ok(id, {});
  if (message.method === "tools/list") {
    return ok(id, modern ? { resultType: "complete", tools: mcpTools, ttlMs: 3e5, cacheScope: "private" } : { tools: mcpTools });
  }
  if (message.method !== "tools/call") return fail(-32601, "Method not found", id);
  const name = params.name;
  if (typeof name !== "string" || !toolsByName.has(name))
    return fail(-32602, "Unknown tool", id);
  const args = checkArguments(name, params.arguments ?? {});
  if (args === null) return fail(-32602, "Invalid tool arguments", id);
  try {
    const resource = toolToResource[name];
    let data;
    if (name === "connect_whoop") {
      if (env.WHOOP_OAUTH_ENABLED !== "true" || typeof whoopAuthorize !== "function") throw Error("Connection disabled");
      const result2 = await whoopAuthorize(db, userId, env);
      const content = { content: [{ type: "text", text: result2.authorization_url }] };
      if (modern) {
        content.resultType = "complete";
        content.structuredContent = result2;
      }
      return ok(id, content);
    } else if (extraTools.some((t) => t.name === name)) {
      data = await readExtraTool(db, userId, name, args);
    } else if (!historyTools.has(name) || !args.auto_page) {
      data = await whoopRequest(db, userId, resource, env, args);
    } else {
      const records = [];
      let cursor = null, pages = 0;
      for (let i = 0; i < 4; i++) {
        const batch = await whoopRequest(db, userId, resource, env, { limit: 25, next_token: cursor });
        if (!isObject(batch) || !Array.isArray(batch.records)) throw Error("Unexpected WHOOP page");
        if (batch.records.length > 25) throw Error("WHOOP page oversized");
        records.push(...batch.records);
        pages++;
        const next = batch.next_token ?? null;
        if (next != null && (typeof next !== "string" || next.length > 512 || next === cursor))
          throw Error("Invalid WHOOP cursor");
        cursor = next;
        if (cursor === null) break;
      }
      data = { records, next_token: cursor, complete: cursor === null, pages_fetched: pages };
    }
    const result = { content: [{ type: "text", text: JSON.stringify(data) }] };
    if (modern) {
      result.resultType = "complete";
      result.structuredContent = data;
    }
    return ok(id, result);
  } catch {
    return toolError(id, "WHOOP data is unavailable for this connection.", modern);
  }
}
__name(handleMcpRpc, "handleMcpRpc");

// ../../src/router.mjs
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer"
    }
  });
}
__name(json, "json");
function createStagingRouter({
  verifyIdentity = /* @__PURE__ */ __name(async () => {
    throw new AccessDenied(401);
  }, "verifyIdentity"),
  whoopRequest = callWhoop,
  whoopAuthorize = createWhoopAuthorization,
  whoopCallback = acceptWhoopCallback
} = {}) {
  return /* @__PURE__ */ __name(async function stagingFetch(request, env) {
    if (env?.MIGRATION_API_ENABLED !== "true")
      return json({ error: "WHOOP Lens Cloudflare migration not activated" }, 503);
    let preliminaryUrl;
    try {
      preliminaryUrl = new URL(request.url);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    if (preliminaryUrl.pathname === "/mcp") {
      if (env?.MCP_ENABLED !== "true") return json({ error: "Cloudflare MCP is not activated" }, 503);
      if (request.method !== "POST") return json({ error: "MCP requires POST" }, 405);
      if (!env?.DB || env?.WHOOP_READS_ENABLED !== "true")
        return json({ error: "Cloudflare MCP is not ready" }, 503);
      const origin = request.headers.get("origin");
      if (origin && ![preliminaryUrl.origin, "https://chatgpt.com", "https://chat.openai.com"].includes(origin))
        return json({ error: "Disallowed origin" }, 403);
      if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json"))
        return json({ error: "JSON required" }, 415);
      const accept = request.headers.get("accept") || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
        return json({ error: "Unsupported MCP Accept header" }, 406);
      if (Number(request.headers.get("content-length")) > 16384)
        return json({ error: "MCP request too large" }, 413);
      let raw;
      try {
        raw = await request.text();
      } catch {
        return json({ error: "Unreadable request" }, 400);
      }
      if (raw.length > 16384) return json({ error: "MCP request too large" }, 413);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const transport = validateMcpTransport(request, message);
      if (transport.error) return json({ error: transport.error }, transport.status);
      try {
        const userId = await verifyIdentity(request, env);
        if (!await activeMembership(env.DB, userId))
          return json({ error: "Not authorized for WHOOP Lens" }, 403);
        const result = await handleMcpRpc(message, {
          db: env.DB,
          userId,
          env,
          whoopRequest,
          whoopAuthorize
        }, transport);
        if (result === null) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
        return json(result);
      } catch (error) {
        if (error instanceof AccessDenied) return json({ error: "Unauthorized" }, error.status);
        return json({ error: "MCP staging unavailable" }, 503);
      }
    }
    if (request.method !== "GET")
      return json({ error: "Unsupported method" }, 405);
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    const whoopRoutes = Object.freeze({
      "/v1/whoop/profile": "profile",
      "/v1/whoop/measurements": "measurements",
      "/v1/whoop/recovery": "recovery",
      "/v1/whoop/sleep": "sleep",
      "/v1/whoop/workouts": "workouts",
      "/v1/whoop/cycles": "cycles"
    });
    const callbackRoute = url.pathname === "/api/whoop/callback";
    const routes = /* @__PURE__ */ new Set([
      "/v1/status",
      "/v1/recovery",
      "/v1/sleep",
      "/v1/whoop/connect",
      ...Object.keys(whoopRoutes)
    ]);
    if (callbackRoute) {
      if (env?.WHOOP_OAUTH_ENABLED !== "true")
        return json({ error: "WHOOP Cloudflare OAuth not activated" }, 503);
      if (!env?.DB) return json({ error: "Staging unavailable" }, 503);
      try {
        const result = await whoopCallback(env.DB, url, env);
        return json(result);
      } catch {
        return json({ error: "WHOOP authorization could not be completed" }, 400);
      }
    }
    if (!routes.has(url.pathname)) return json({ error: "Not found" }, 404);
    if (!env?.DB) return json({ error: "Staging unavailable" }, 503);
    try {
      const userId = await verifyIdentity(request, env);
      const permitted = await activeMembership(env.DB, userId);
      if (!permitted) return json({ error: "Not authorized for WHOOP Lens" }, 403);
      if (url.pathname === "/v1/whoop/connect") {
        if (env?.WHOOP_OAUTH_ENABLED !== "true")
          return json({ error: "WHOOP Cloudflare OAuth not activated" }, 503);
        const result = await whoopAuthorize(env.DB, userId, env);
        return json(result);
      }
      if (url.pathname === "/v1/status") {
        const status = await connectionStatus(env.DB, userId);
        return json({ connected: status.connected, source: "cloudflare-staging" });
      }
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit != null && !/^([1-9]|1[0-9]|2[0-5])$/.test(rawLimit))
        return json({ error: "Invalid limit" }, 400);
      if (Object.hasOwn(whoopRoutes, url.pathname)) {
        if (env?.WHOOP_READS_ENABLED !== "true")
          return json({ error: "WHOOP Cloudflare reads not activated" }, 503);
        const nextToken = url.searchParams.get("next_token");
        if (nextToken != null && nextToken.length > 512)
          return json({ error: "Invalid cursor" }, 400);
        const category2 = whoopRoutes[url.pathname];
        const data = await whoopRequest(env.DB, userId, category2, env, {
          limit: rawLimit == null ? 10 : Number(rawLimit),
          next_token: nextToken
        });
        return json({ category: category2, data, source: "whoop-cloudflare-staging" });
      }
      const category = url.pathname === "/v1/recovery" ? "recovery" : "sleep";
      const records = await readHistory(env.DB, userId, category, rawLimit == null ? 10 : Number(rawLimit));
      return json({ category, records, source: "cloudflare-staging" });
    } catch (error) {
      if (error instanceof AccessDenied) return json({ error: "Unauthorized" }, error.status);
      return json({ error: "Staging service unavailable" }, 503);
    }
  }, "stagingFetch");
}
__name(createStagingRouter, "createStagingRouter");

// src/index.mjs
var mcpResource = new OAuthResourceServer({
  resourceMetadata: {
    resource: "https://whooplens.tech/mcp",
    authorization_servers: ["https://auth.whooplens.tech"],
    resource_name: "WHOOP Lens (private read-only MCP)"
  },
  requiredScopes: ["mcp:read"],
  validateToken: /* @__PURE__ */ __name((env) => env.AUTH_SERVER.validateToken, "validateToken"),
  handler: {
    async fetch(request, env, ctx) {
      if (env.OAUTH_RESOURCE_ENABLED !== "true" || env.MCP_ENABLED !== "true" || env.WHOOP_READS_ENABLED !== "true" || env.MIGRATION_API_ENABLED !== "true")
        return Response.json({ error: "WHOOP Lens MCP OAuth is disabled" }, { status: 503 });
      if (!ctx.auth.scope.includes("mcp:read"))
        return insufficientScope(ctx.auth, ["mcp:read"]);
      const id = ctx.props?.userId;
      if (typeof id !== "string" || !env.DB || !await activeMembership(env.DB, id))
        return Response.json({ error: "Not authorized" }, { status: 403 });
      return createStagingRouter({ verifyIdentity: /* @__PURE__ */ __name(async () => id, "verifyIdentity") })(request, env);
    }
  }
});
var index_default = {
  fetch(request, env, ctx) {
    if (env?.OAUTH_RESOURCE_ENABLED !== "true")
      return Response.json({ error: "WHOOP Lens resource server not activated" }, {
        status: 503,
        headers: { "cache-control": "no-store" }
      });
    if (new URL(request.url).pathname === "/api/whoop/callback")
      return createStagingRouter()(request, env);
    return mcpResource.fetch(request, env, ctx);
  }
};
export {
  index_default as default
};
