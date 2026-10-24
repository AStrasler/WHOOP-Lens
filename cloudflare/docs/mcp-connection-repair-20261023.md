# ChatGPT metadata outage and reconnect mitigation — October 23, 2026

## Confirmed evidence

Production auth logs contained nine warnings on October 23 reporting HTTP 404
while resolving `https://chatgpt.com/oauth/client.json`. Six corresponding
token-endpoint errors were `invalid_client`; other failures occurred during
authorization. This establishes a concrete failure before WHOOP API reads.
The logs do not identify the member, so they do not prove every reported
disconnect has this cause. Notion support is unrelated.

The pinned provider treats CIMD resolution failure as invalid_client. The prior
diagnostic allowlist also collapsed its category and reason to `other`.

## Repair

- Discovery now advertises dynamic client registration rather than CIMD for
  new connections. Registered clients resolve from the existing server KV;
  their refreshes do not require fetching ChatGPT's metadata document.
- Existing CIMD processing remains enabled internally so existing grants are
  not stranded by disabling the capability.
- The provider error hook translates metadata resolution failures to HTTP 503
  `temporarily_unavailable` with Retry-After 60, rather than invalid_client.
  It does not permit authentication without metadata or weaken client checks.
- The diagnostic allowlist recognizes the actual CIMD category and reason.

An existing CIMD connection still needs its metadata endpoint to recover, or
legitimate authorization through registration. Returning 503 cannot force a
particular ChatGPT client to retain credentials. The real member's refresh
remains the acceptance check; do not claim it has been observed.

## Validation and production release

27 focused tests passed, covering real-provider DCR discovery and registration
without outbound metadata requests, consent and PKCE, account access checks,
refresh rotation beyond initial expiry, lost-response retry, and error privacy.

Released only the authorization Worker at 23:18:00 UTC (6:18 p.m. Chicago).
Version: `5ff00a64-77de-466e-aa65-aeaaf17a7bd2`, 100% traffic.
Deployment: `dff8fa45-6627-4f5e-84c2-6057cbccfff5`.
Rollback: `5626e196-ece2-4b03-8bb3-54aacf3bdd87`.

The release applied guarded replacements to the downloaded production module
and added the tested discovery helper, avoiding unrelated dependency changes.
Bindings and settings were read back after deployment: existing D1, KV, Access
settings, activation flags, mailer, Turnstile configuration and secret binding
were retained. Logging retains query redaction with invocation logs and traces
disabled. No member grants, identities, credentials or health records were
modified. The MCP resource Worker was not deployed.

Public post-release checks:

- Issuer discovery: 200, CIMD advertised false, registration endpoint present,
  issuer identification true and S256 retained.
- Protected resource metadata: 200.
- Unauthenticated MCP: 401 with the expected Bearer metadata challenge.
- Token request using a deliberately invalid synthetic token and ChatGPT CIMD
  client ID: 400 invalid_grant / Invalid token format. Metadata resolution had
  recovered by this probe; this verifies normal rejection, not member refresh.

No end-to-end member acceptance or long-term reliability claim is made.

References: https://developers.openai.com/plugins/build/auth and the pinned
workers-oauth-provider implementation of getClient/parseTokenEndpointRequest.
