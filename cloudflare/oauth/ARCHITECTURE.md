# WHOOP Lens: Cloudflare OAuth 2.1 staging architecture

**2026-10-11 status: SOURCE BUILDS, RESOURCE PROVISIONED, NOT ACTIVATED.**
Supabase remains the production authentication and MCP service. No users or
tokens were migrated; no GitHub branch was merged and no new app was deployed.

## Fixed intended endpoints (not yet routed)

- WHOOP Lens resource and token audience: https://whooplens.tech/mcp
- Independent OAuth 2.1 issuer: https://auth.whooplens.tech
- OAuth authorization endpoint: /authorize
- OAuth token and revocation endpoint: /oauth/token
- OAuth dynamic registration compatibility: /oauth/register
- Well-known OAuth discovery: served by official Cloudflare v1 provider
- Both domains are **NOT attached**, with no Cloudflare DNS zone activated.

## Split Worker roles

- Existing Worker resource: whoop-lens (currently has a prior deployed version;
  its public and preview workers.dev URLs are disabled).
- Newly provisioned empty Worker: whoop-lens-auth; Cloudflare API confirms
  deployed_on=null, no domain and no publicly enabled workers.dev/preview URL.
- OAuth KV: whoop-lens-oauth-staging (new empty namespace, no production tokens).
- D1: whoop-lens-migration (existing synthetic-safe staging database).
- A future Service Binding AUTH_SERVER lets the MCP resource validate its bearer
  token without making another Internet request.
- Official OAuth framework: @cloudflare/workers-oauth-provider pinned to 1.2.3.
  It handles registered clients, CIMD/DCR, S256 PKCE, audience-constrained
  access tokens, refresh/revocation and OAuth metadata, instead of bespoke code.
- The resource wrapper checks mcp:read, authenticated user ID, explicit active
  membership in D1 and the pre-existing MCP/router runtime gates.
- SSRF mitigation: global_fetch_strictly_public required for CIMD metadata URLs.

## Deliberately closed gates

Auth Worker: OAUTH_SERVER_ENABLED=false, OAUTH_CONSENT_ENABLED=false.
Resource Worker: OAUTH_RESOURCE_ENABLED=false, MCP_ENABLED=false,
MIGRATION_API_ENABLED=false, WHOOP_READS_ENABLED=false, WHOOP_OAUTH_ENABLED=false.
Both Workers have workers_dev=false, preview_urls=false and NO routes.

The consent source now contains an explicit Allow/Deny flow and transitional
Supabase-verified sign-in, but it remains entirely inactive. OAuth token and
metadata endpoints still return 503 while disabled. This is NOT a deployed or
production-ready authorization service.

## Validation completed

- Official SDK and Wrangler pinned in cloudflare/package.json.
- Both Worker entry points passed Wrangler --dry-run bundling in GitHub Actions
  with no Cloudflare deployment.
- Node tests verified disabled issue paths, HTML escaping of untrusted client
  metadata, exact resource/issuer/scope and no public route in the configs.
- Existing Cloudflare D1/MCP security tests and regular repository integration
  tests remained passing.
- Cloudflare API confirmed empty auth Worker has no deployed version, no custom
  domain, public URL or preview URL. Existing WHOOP Worker also stays private.

## Remaining before any private end-to-end trial

1. Review and harden transitional Supabase-based sign-in and explicit consent,
   then decide whether to keep this provider or replace it with an independent
   identity solution. Do NOT auto-approve any client.
2. Implement CSRF-safe user session handling, login retry/rate limiting, consent
   client verification and identity-provider revocation; test forged clients,
   redirect URI changes, stale sessions, XSS, cross-user and replay attempts.
3. Audit identity mapping against Supabase's current members, including the
   previously identified connected account missing an explicit member row.
   Do not silently grant access or lock out existing users.
4. Test complete OAuth authorization-code + S256 PKCE + refresh + revocation +
   ChatGPT registration + audience validation against a privately protected
   endpoint using synthetic test users.
5. Review Cloudflare Zero Trust for staging/admin access. Do not put an
   interactive Access challenge in front of machine OAuth callbacks or /mcp
   unless the client has a compatible service authentication mechanism.
6. Before actual domain/redirect activation, secure explicitly approved domain
   and WHOOP OAuth changes, data-transfer plan, rollback and owner approval.
7. Do not assume Cloudflare KV defaults meet any specific health-data residency
   requirement; review regulatory, consent, retention and logging requirements
   before copying any records.

A green dry-run build is NOT authorization to deploy, publish or migrate data.


## Single-batch staged OAuth sign-in and explicit consent (2026-10-11)

This batch implements a **transitional**, not independently hosted, identity
flow. It is code-only, disabled by both OAUTH_SERVER_ENABLED=false and
OAUTH_CONSENT_ENABLED=false, and cannot run on any public URL.

- GET /authorize validates exact client, redirect, resource and PKCE through
  the official provider, describes the client and redirect destination, then
  calls beginConsent() to issue the provider's browser-bound, short-lived
  consent handle/cookie. The form escapes all client metadata and displays
  the target host, requested scopes, and loopback warnings.
- POST /authorize supports explicit Allow/Deny only. Deny calls denyConsent().
  Allow calls approveConsent() and verifies the chosen scopes against the
  original request. It never grants a scope the user did not select.
- Identity is provisionally established with the EXISTING Supabase password
  sign-in endpoint and checked again via Supabase Auth /auth/v1/user. After
  login, active D1 membership with a matching Supabase identity mapping is
  required. Connected accounts with no explicit active membership are denied.
- Credentials and Supabase session tokens are handled transiently and not
  stored in cookies, D1, KV or OAuth token props; only an approved user ID is
  passed to completeAuthorization(). No Supabase password, signing key or
  existing WHOOP token has been copied.
- D1 migration 0003 adds atomic 5-attempts-per-15-min sign-in limits for
  HMAC-hashed IP and email buckets. The Cloudflare AUTH_RATE_HMAC_KEY is
  required at runtime and must be configured as a secret, not committed.
  The counters store no raw email, IP or password. Cleanup of old counters
  and further bot protection remain a prelaunch task.
- Synthetic tests cover approve/deny, escaped untrusted client metadata,
  consent feature gates, login with a disabled invitation, cookie headers,
  nonce-independent D1 rate limits and generalized errors.

CRITICAL: The present architecture forwards a password entered into a
Cloudflare-hosted form to Supabase for verification. A full privacy and
threat-model review, sign-in UX review, independent IdP decision and
end-to-end OAuth conformance checks are mandatory before enabling the form.
Because D1 has no user rows, no real user could be approved with the current
empty staging data even if flags were enabled. The Worker is not deployed.


## Consent security review and regression batch (2026-10-11)

The following changes are **staging source only** with no Worker deployment
or additional paid services:

- POST /authorize now checks exact canonical auth host, browser Origin and
  Sec-Fetch-Site (when present) before consuming a consent handle or attempting
  identity verification. The official provider's one-time, browser-bound
  consent cookie remains the primary CSRF protection.
- Accepted form content-type is restricted to a real URL-encoded form, not
  arbitrary MIME strings that merely share the same prefix.
- The Cancel action is a distinct HTML form carrying only the consent handle.
  The server rejects deny requests containing email, password or scopes,
  reducing accidental credentials submitted on cancellation.
- Supabase password authentication temporarily creates a Supabase session.
  We now call Supabase Auth's local logout endpoint to revoke the refresh
  session, including when an account is no longer an invited active member.
  Logout failure denies the WHOOP Lens authorization. Supabase access JWTs
  may remain valid until expiry, even after logout; they are never persisted
  or returned from this flow.
- Synthetic regression tests cover cross-site and unexpected-host POSTs,
  rejected credential-bearing denial forms, successful session cleanup and
  failure-to-logout fail-closed behavior.

**Unresolved high-risk design choice:** the transitional password form receives
a Supabase account password on the future Cloudflare authorization origin and
forwards it to Supabase Auth. Not storing the password does not eliminate the
added handling of account credentials. Consider a redirect-based upstream login
with short-lived, browser-bound PKCE state instead before enabling any live
login. The above hardening does NOT authorize activating password-based login.
Review branding, domain ownership, anti-phishing, breach response and identity
provider strategy before deploying any sign-in entry point.

**Additional prelaunch work:** quantify email-based lockout/DoS potential in
five-attempt counters, prune old buckets, test logout against the actual
Supabase configuration, and run independent OAuth client conformance and
revocation tests. No accounts, secrets, or health records are migrated.

