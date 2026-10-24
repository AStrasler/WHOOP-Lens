# MCP reconnect investigation — 2026-10-22

## Finding and limits

The reported symptom is a repeated ChatGPT reconnect prompt with no displayed error.
The immediate production cause is **not yet confirmed**. Do not describe this patch
as a proven repair for that loop. The read-only investigation was followed by an
explicitly approved authorization-Worker deployment; see the deployment record below.
No production identity, membership, or stored member credential was manually changed.

A separate, reproducible persistence defect was found: workers-oauth-provider
1.2.3 defaults to a fixed 30-day grant lifetime. Refresh rotation does not extend
that lifetime unless `refreshTokenIdleTTL` is configured. This patch sets a 30-day
idle lifetime, retaining a 30-day initial lifetime. It cannot explain freshly
issued grants immediately reconnecting, and it is not evidence of the reported
member's original disconnect.

The other confirmed defect is an investigation blind spot: the authorization
Worker has no persisted observability configuration, and existing D1 diagnostic
capture lives behind resource authentication. Neither records the OAuth refresh
failure that would distinguish expired grants, stale refresh tokens, client
authentication, KV throttling, and callback rejection. The patch replaces the
provider's free-text error logger with fixed allowlisted categories and reasons,
and adds optional fixed consent/issuance stage events. It changes no OAuth error
responses and never logs tokens, descriptions, headers, subjects, emails or bodies.

## Production evidence (read-only)

Checked October 22, 2026, approximately 21:15–21:25 UTC.

| Lifecycle stage | Evidence and result |
| --- | --- |
| OAuth discovery | Public issuer metadata returned 200 with the expected issuer, token and authorization endpoints, S256, code and refresh grants, registration and CIMD support. |
| Resource discovery | `/.well-known/oauth-protected-resource/mcp` returned 200, the canonical MCP resource, correct issuer, and `mcp:read`. |
| Challenge | Unauthenticated `/mcp` returned 401 with `WWW-Authenticate` pointing to resource metadata and `mcp:read`. No Access login redirect intercepted it. |
| Client identification | The affected member's three recent KV grants name ChatGPT's stable CIMD client ID and connector callback. The current ChatGPT CIMD document supports both code and refresh grants. |
| Access authentication | Account audit log confirms the supplied allow event at 20:51:43 UTC. |
| Identity and membership | The affected Access user ID matches an enabled issuer/subject mapping. The linked internal identity has active membership and satisfies `ACTIVE_MEMBER_SQL`. No relinking is indicated. |
| Consent/code exchange | Three affected-member grants were created at 21:06:25, 21:06:35 and 21:06:44 UTC. All have `mcp:read`, refresh-token state, and approximately 30-day expiry. These are evidence of completed code exchanges, not refresh failures. |
| Resource acceptance | Three affected-member access-token records existed with expirations around 22:06 UTC. Five MCP POST invocation records returned HTTP 200 around the code exchanges. Logs do not tie those requests to a member or prove their JSON-RPC payloads succeeded. |
| Refresh | No retained authorization-Worker trace establishes a refresh attempt or its response. Existing resource D1 diagnostics contain no corresponding MCP OAuth failure. Absence of capture is not proof of absence of failures. |
| Worker versions | Auth `54791d32-101d-414e-a3b9-486e1d9c890a` at 100%; resource `51d0ab11-d16a-49a0-9d20-8a5b2d663476` at 100%. |
| Live implementation | Downloaded auth script inspection confirms connectorRefresh policy, separate access-token props and previous-refresh-token support. The live callback matches the repository's relevant policy. |

Only structural grant fields and token-record expirations were inspected. Refresh
credentials, wrapped keys, encrypted props and health records were not exposed or
used. Identifiers and member email are intentionally omitted from this report.

## Code trace

1. `oauth/resource/src/index.mjs` uses the provider's metadata/challenge handler,
   canonical audience validation and auth-Worker service binding.
2. `auth-server/src/index.mjs` uses the pinned provider for DCR/CIMD, PKCE,
   code exchange, encrypted grants, token rotation and revocation.
3. `consent-flow.mjs` validates selected scopes against the original request,
   consumes browser-bound consent and upstream state, and completes authorization
   only after independent identity verification. Explicit offline-access decline
   still suppresses refresh issuance. When offline access was never offered,
   `connectorRefresh` authorizes connector persistence without adding resource scopes.
4. `upstream.mjs` checks RS256 signature, configured JWK endpoint, issuer,
   audience, app type, timestamps and claims, then requires enabled subject mapping
   and active internal membership. It never links by email.
5. `refresh-grant.mjs` consults original grant scope and encrypted grant props.
   The provider supplies grant scope, separately from requested access-token scope.
   Narrowing access-token scope therefore does not erase refresh permission.
6. The issuer exposes only `{userId}` as access-token props and retains connector
   permission on the encrypted grant. The resource checks active membership again.
   Seat capacity is enforced for WHOOP account connection; there is no additional
   OAuth seat allocation, so reconnecting does not consume another seat.
7. MCP uses a stateless HTTP router; OAuth grant and token state live in KV,
   not a browser session or an individual Worker isolate. Access login expiry
   does not itself expire an issued MCP refresh grant.

## Validation

- All 427 standard `cloudflare/test/*.test.mjs` tests pass on Node 24.
  Windows checkout converted two existing text fixtures to CRLF; normalizing their
  working copies temporarily to LF removed five unrelated fixture-comparison failures.
  Their original checkout line endings were restored after testing; they are not
  part of the patch.
- Real pinned-provider OAuth suite plus OAuth unit suites: 32 tests pass on the
  final source. Tests cover PKCE, state/cookie replay, explicit consent
  decline, narrowing, revocation, and access-token props.
- New time-travel regression refreshes through days 1, 29, 31, 59 and 87; checks
  expired access tokens, wrong-resource rejection, stale-token rejection without
  revoking the current session, and expiry after 31 days idle.
- Lost-response retry with the previous refresh token passes.
- Both authorization and resource Worker dry-run bundles build. No upload or
  deployment occurred.
- The unrelated real-D1 Miniflare suite failed to start correctly in the restricted
  Windows runtime and was interrupted. Do not claim that suite passed; this patch
  changes no D1 SQL or migrations.

## Prepared rollout — explicit approval required

Deploy **only the authorization Worker** after review; no resource deployment or
identity repair is currently supported by evidence. Preserve the current KV and D1
bindings, Access issuer/audience, enabled OAuth/consent flags, seat-request flags,
mailer destination, Turnstile site key and existing secret binding. The checked-in
Wrangler file is intentionally disabled and lacks the full production mailer
configuration: **do not deploy it directly to production**.

The ignored local artifact `oauth/auth-server/dist/oauth-auth/production-candidate.jsonc`
contains the reviewed production variables and non-secret bindings, with the built
`index.js` beside it. It preserves the existing mailer and Turnstile site key.
The existing Turnstile secret must be retained by the deployment tool; no secret
value is present in the file. At release time, re-read production settings and
compare them with the candidate before uploading. Enable persisted application logs with
automatic invocation logging disabled, query redaction enabled, and traces off.
Set `DIAGNOSTICS_CAPTURE_ENABLED=true` on the auth Worker to enable the additional
fixed stage events. The error hook always emits only allowlisted fields, matching
the provider's existing always-on error logging behavior. Review logs for privacy
before enabling persistence: invocation URLs and SDK debug output must not be captured.
Keep the deploy configuration and compiled bundle local; neither should contain secrets.

After deployment, the member should retry using the existing ChatGPT connection.
Capture one fresh consent/code exchange and one refresh around access-token expiry.
Do not test by replaying the member's refresh token through an operator tool.
Verify successful action discovery, a later refresh and continued tool use without
another prompt. If reconnect recurs, inspect `oauth_failure` category/reason and
the last `oauth_stage` event, using timestamps to correlate the member's attempt.
An `*_allowed` event means policy permitted the exchange, not that token storage
or delivery completed.

| Diagnostic reason | Next action |
| --- | --- |
| `refresh_token_mismatch` | Investigate client use of stale rotated credentials and KV consistency; do not delete the grant as a workaround. |
| `grant_not_found` / `refresh_token_expired` | Check grant retention and expiry against the request time; existing expired grants require legitimate reauthorization. |
| `client_assertion_invalid` or other client reasons | Check ChatGPT CIMD/JWKS/client authentication; do not replace the member identity. |
| `kv_rate_limited` | Preserve credentials and honor retry behavior; this is transient, not missing consent. |
| `refresh_permission_denied` | Inspect original consent policy. Never enable offline access on an explicitly declined grant. |
| `upstream_identity_failed` | Recheck JWT verification, mapping and membership; the event intentionally does not reveal claims. |
| All OAuth exchanges succeed | Investigate MCP protocol/discovery responses and ChatGPT connection state; HTTP 200 alone is insufficient. |

Acceptance requires a real client refresh without the reconnect loop. Until that
is observed, the original incident stays open. Rollback is the exact auth version
`54791d32-101d-414e-a3b9-486e1d9c890a` at 100%, restoring the prior settings as
needed. Rollback requires no data migration, token deletion or identity changes;
grant expirations already extended by a successful refresh remain extended.

References: [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth),
[ChatGPT CIMD](https://chatgpt.com/oauth/client.json), and the installed pinned
provider's `refreshTokenTTL`, `refreshTokenIdleTTL`, `handleRefreshTokenGrant`,
`saveGrantWithTTL` and `callTokenExchangeCallback` implementations.

## Approved deployment record

The owner explicitly approved deployment in this chat on October 22, 2026.

- Auth bundle SHA-256:
  `AE3A07D71F9D1FEE79334DCF47E5ECAFACF55A2D248EC7BB3B5D17AB5CB71573`.
- Initial deployment: `6c220646-362d-49d7-a079-85f63a3b9703`, at 21:33:41 UTC.
- Final active version after enabling query redaction and disabling trace persistence:
  `5626e196-ece2-4b03-8bb3-54aacf3bdd87`, at 21:34:11 UTC (4:34:11 p.m. Chicago).
- Final deployment ID: `a1641a9a-dc24-4695-b025-c0ec559e5df6`, 100% traffic.
- Existing auth settings and bindings, including the Turnstile secret binding,
  were read back and preserved. `DIAGNOSTICS_CAPTURE_ENABLED=true` was added.
- Persisted application logs are enabled; automatic invocation logs and traces
  are disabled. Query redaction is enabled. No health data or credentials were
  submitted to the endpoint during verification.
- MCP Worker remains on `51d0ab11-d16a-49a0-9d20-8a5b2d663476`.
- Post-deploy issuer metadata and protected-resource metadata returned 200;
  unauthenticated MCP returned the correct 401 Bearer challenge.
- A credential-free token POST returned the expected 401 `invalid_client`.
  This verifies the endpoint's error response, not a member refresh.

Member acceptance remains outstanding: retry the existing ChatGPT connection,
then confirm that it stays connected through a real refresh. No manual grant
deletion, identity modification or credential replay was performed.
