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

The current authorization handler only validates/looks up client metadata to
render an XSS-escaped **inactive** consent preview. It cannot authenticate
anyone, display an approval button, call completeAuthorization or issue
credentials. OAuth metadata and token endpoints also return 503 while disabled.
The source is an architectural foundation, NOT a working authorization service.

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

1. Design and implement independent secure user identity, sign-in sessions,
   verified active memberships, and fully explicit consent using the official
   beginConsent/approveConsent/denyConsent APIs. Do NOT auto-approve any client.
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
