# WHOOP Lens: Supabase to Cloudflare migration

Status as of 2026-10-12: **Supabase stays live. The private MCP is also live on Cloudflare.**

- Private server: `https://whooplens.tech/mcp` on Worker `whoop-lens`.
- Authorization server: `https://auth.whooplens.tech` on Worker `whoop-lens-auth`.
- Scope: `mcp:read`. Resource name: WHOOP Lens (private MCP). WHOOP API calls stay read-only. Account tools can disconnect stored WHOOP credentials and import a consented Health Connect file.
- `workers.dev` and preview URLs are disabled.
- WHOOP OAuth on Cloudflare is on. The Worker has `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`. A connection is stored only after a separate WHOOP authorization, and the WHOOP app must allow `https://whooplens.tech/api/whoop/callback`.
- D1 has one membership and zero WHOOP connections. Refresh tokens are not copied from Supabase.
- AI summaries are implemented and left off. `AI_SUMMARY_ENABLED` is `"false"` on the whoop-lens and resource Workers. The auth Worker does not declare the AI, stress, or digest flags. They cover WHOOP measurement reads and stored Health Connect reads. Migration `migrations/0009_ai_usage.sql` stores daily neuron counters. Migration `migrations/0010_ai_account_snapshot.sql` caches the account-wide Workers AI neuron total from the GraphQL Analytics API. The read-only secret is `AI_ACCOUNT_ANALYTICS_TOKEN` (Account Analytics Read) and the account id setting is `AI_ANALYTICS_ACCOUNT_ID`. Neither is committed, and neither migration is applied here. A failed analytics read, or a fetch whose freshness watermark is older than 10 minutes (`ANALYTICS_STALE_MS`), keeps the template summary, including `chart_data` and deterministic `insights`. The last call time is not that watermark. Local reservations after the last counted call are counted. Migration `migrations/0012_ai_usage_event.sql` stores those reservation times, indexes `(day, at_ms)`, and is not applied here. Rows from earlier UTC days are deleted on the next budget read. A reservation whose event row cannot be written is undone. `STRESS_ESTIMATE_ENABLED` and `WEEKLY_DIGEST_ENABLED` are `"false"` on those same two Workers. The stress series is an empty placeholder and is not calculated. The weekly digest tool is pulled by the caller's ChatGPT scheduled task. It caches one digest per account per week in `migrations/0011_ai_weekly_digest.sql`, which is not applied here. It does not send mail and it has no cron. A suggested task prompt is: Every Monday 8 AM, call WHOOP Lens get_weekly_digest and chart it. `get_ai_usage` shows that account's own quota, and the global total only to the developer user id.
- GitHub Workers Builds on `main` do not auto-run `npx wrangler deploy`. Cloudflare preview builds are off, so a push does not run `npx wrangler preview`.
- The sections below are the 2026-10-11 staging log. They describe that day's upload, not the current deployment.

Cloudflare account: dedicated WHOOP Lens account.
Cloudflare Worker name: `whoop-lens`.
Custom domain: `whooplens.tech` for the resource Worker and `auth.whooplens.tech` for the issuer.
Default workers.dev and preview URLs: disabled.
Live API flags: `MCP_ENABLED`, `MIGRATION_API_ENABLED`, `OAUTH_RESOURCE_ENABLED`, `WHOOP_READS_ENABLED`, and `WHOOP_OAUTH_ENABLED` are true.
D1 database: whoop-lens-migration, ID 58250de2-cad7-4a8a-a061-d9b41c7b24d2.
The database was created and the exact SQL in migrations/0001_initial.sql was applied successfully on 2026-10-11.

## Grounded source inventory

- Supabase project evoiwauqplbcecumiwqn is healthy (PostgreSQL 17).
- Live Edge Functions: whoop-mcp v44 and samsung-health v1.
- Source tables: whoop_connections, whoop_members, whoop_oauth_states, whoop_recovery,
  whoop_sleep, samsung_health_records, whoop_waitlist.
- Supabase Auth contains user identities, sessions, authorizations/consents, OAuth
  clients, and refresh tokens; these are **not** portable to D1 by a SQL copy.
- The staged PR's Health Connect and medical-context schemas are not live in Supabase.
- Supabase Storage has no buckets or objects to migrate.
- No live data was copied to Cloudflare.

## Completed isolated development stage (2026-10-11)

- Created a D1 staging schema containing 10 application tables, with no real account or health data.
- Implemented a **temporary Supabase-authenticated Cloudflare Worker bridge** in
  `src/identity.mjs`, `src/storage.mjs`, and `src/router.mjs`.
- A valid Supabase access token is checked with the live Supabase Auth
  `GET /auth/v1/user` endpoint, not decoded and trusted locally. This is
  temporary and **Supabase remains the identity provider until final replacement**.
- A missing or inactive D1 membership **DENIES** access even when a connection row exists.
  D1 reads are restricted to the verified user's ID by bound SQL parameters.
- Implemented *read-only* staged `/v1/status`, `/v1/recovery`, `/v1/sleep` routes.
  Requests using POST/PUT/PATCH/DELETE are rejected. No generic SQL route exists.
- Worker API is disabled unless explicitly configured
  `MIGRATION_API_ENABLED=true`. In this repo, `wrangler.jsonc`
  fixes it at `false`, and workers.dev + preview URLs are disabled.
- Added Cloudflare-specific AES-GCM token envelopes in
  `src/token-crypto.mjs` using a new 256-bit secret, per-user/per-purpose AAD,
  and unique nonces. Existing Supabase encryption keys and WHOOP credentials
  have **not** been copied. This does not yet implement a new WHOOP OAuth callback.
- Added GitHub Actions isolation tests using real in-memory SQLite and synthetic
  accounts, and AES-GCM tampering tests. CI checks do not deploy.
- **No new OAuth clients, DNS settings, workers routes, or API keys were activated.**
  There is no public Cloudflare service to visit yet.

## Cloudflare account checkpoint (2026-10-11, verified directly)

- A Worker resource named `whoop-lens` **already existed** in the account, created
  and deployed at approximately 13:00 UTC. Its prior deployment was not created
  by these migration commands. Do not assume its deployed code is the tested
  migration code; review it separately before enabling any public route.
- Worker `workers.dev` **disabled** and Worker preview/version URLs **disabled**,
  verified with the Cloudflare API. No custom domains or Cloudflare DNS zones
  attached. `whooplens.tech` is still only the intended future domain.
- Cloudflare Worker URL log query strings are now **redacted** to avoid exposing
  WHOOP authorization codes or OAuth state parameters.
- The new source version **4** of `whoop-lens` was uploaded to Cloudflare on
  2026-10-11 with seven ES modules. Version ID:
  `d33c4db2-3d7e-4493-a541-ac0992700b60`.
  It binds to staging D1 and sets all three API flags to `false`.
  **This version was NOT deployed; the existing deployment remained unchanged.**
- GitHub Cloudflare isolation tests and existing integration, Health Connect, and
  Android compile workflows all passed for the OAuth/WHOOP API implementation.
- Implemented WHOOP token refresh, six WHOOP data read categories, one-time hashed
  WHOOP OAuth state handling, encrypted callback storage and isolated developer/public
  seat assignment using synthetic account tests. All code remains **disabled**.
- Applied D1 migration `0002_enforce_seat_limits.sql`, enforcing maximum 9 public
  WHOOP seats and a single developer seat (existing unique partial index).
- Real WHOOP client secrets, encrypted tokens, login records and health data have
  **not** been copied to Cloudflare. OAuth redirect is still configured to Supabase
  at WHOOP and has **not** been changed. The Cloudflare callback's future target
  `https://whooplens.tech/api/whoop/callback` is for later approval and cannot
  work until DNS, routing and WHOOP redirect registration are configured.

### Important distinction: upload vs deploy

An uploaded Worker version is inert until a Cloudflare deployment points traffic
at it. The current deployment predates this staged version and is **not**
evidence that Cloudflare is running WHOOP Lens. Public and preview routing are off
at the Cloudflare API. DNS and WHOOP OAuth registrations remain unchanged.

## MCP protocol port (staging only, 2026-10-11)

- New `src/mcp.mjs` maps **six read-only WHOOP MCP tools** to the existing
  Cloudflare D1-backed WHOOP API adapter: profile, body measurements, recovery,
  sleep, workouts and cycles. It does not advertise uploads, mutations or
  unfinished optional Health Connect/medical context.
- New `POST /mcp` support handles modern stateless MCP `2026-07-28` request
  headers and `2025-11-25` initialization/list/call semantics, within a strict
  16KB request-body cap. No stateful sessions or streaming notifications.
- Every request verifies the Supabase Auth bearer (transitional identity
  bridge), **then** active account membership in D1. MCP calls cannot choose
  their own user ID. A supplied browser Origin must be allowlisted, and
  protocol method/tool headers must match the JSON-RPC body.
- Tool arguments and page sizes are bounded; four pages/100 records maximum
  for auto-page; unexpected errors never include WHOOP tokens, user identifiers,
  SQL text or secret values. Synthetic tests cover these constraints.
- A separate `MCP_ENABLED=false` Worker flag complements
  `MIGRATION_API_ENABLED=false` and `WHOOP_READS_ENABLED=false`.
- The MCP-ready source bundle was uploaded to Cloudflare as **Worker version 5**
  (ID `5733dec5-761e-4cf8-8997-79a0970a807f`), with eight modules,
  D1 staging binding and all four feature flags set to `false`.
  This was an **UPLOAD ONLY**, not a deployment; the currently deployed Worker
  version remains unchanged, with public `workers.dev` and preview URLs disabled.
- **NOT yet a production-ready ChatGPT MCP URL**: the Cloudflare app does not
  yet issue OAuth 2.1 access tokens; Supabase user bearer validation is only
  a transitional staging bridge. Before claiming compatibility, integrate and
  test an independent OAuth authorization/resource server, ChatGPT client
  registration, account consent, and protocol conformance using a protected
  non-production endpoint.
- No new Cloudflare Worker deployment, public URLs, custom domain routes,
  WHOOP re-authorization, actual account data transfer, or Supabase changes
  occurred as part of the MCP source work.

## Official Cloudflare OAuth 2.1 architecture (2026-10-11)

- Added split-role Cloudflare OAuth server and MCP resource-server source under
  `cloudflare/oauth/`, with `@cloudflare/workers-oauth-provider@1.2.3` pinned.
- Created empty Cloudflare KV namespace `whoop-lens-oauth-staging` and provisioned
  empty `whoop-lens-auth` Worker. Cloudflare API verified **deployed_on=null**,
  public workers.dev and preview URLs disabled, and no custom domain attached.
- Planned issuer `https://auth.whooplens.tech` and resource
  `https://whooplens.tech/mcp`; neither URL has DNS/routing configured.
- Both split Worker source entries **passed Wrangler dry-run builds**; consent
  and identity are intentionally unimplemented. OAuth issuance and private
  resource entry points return 503 while all feature flags remain false.
- Official SDK handles OAuth metadata, S256 PKCE, CIMD/DCR, token audiences,
  refresh/revocation once enabled; application-owned identity verification and
  explicit user consent are NOT DONE. No OAuth clients or users migrated.
- See `cloudflare/oauth/ARCHITECTURE.md` for the verified security boundary,
  testing and the remaining cutover gates.
- No Cloudflare Worker deployment, Supabase production change, DNS activation,
  WHOOP OAuth redirect update, data copy or public URL activation was performed.

## Cutover roadmap

**Next:** test the interim bridge in a separately secured environment with
synthetic accounts only; build independent Cloudflare identity and OAuth
authorization server, port WHOOP API/token-refresh and client registrations,
integrate backend with the web app, and review invite-only enforcement.
Then plan user identity/consent migration (possibly requiring reauthorization),
secure data transfer, dual-service parity checks, rollback, and a separately
approved cutover. Never switch production merely because CI is green.

## Non-negotiable cutover gates

1. Select and implement a **replacement for Supabase Auth and its OAuth 2.1 provider**,
   with per-user sessions, client registration, PKCE, token exchange and revocation
   as required by the actual ChatGPT plugin. Re-authentication may be required.
2. Implement Workers-based isolation because **D1 is SQLite and does not enforce
   PostgreSQL RLS**. All D1 access must be internal to authorized Workers.
   The user must have explicit ACTIVE membership; a missing membership denies access.
3. Implement the WHOOP OAuth redirect and refresh flow in Workers. Register the new
   redirect URI with WHOOP **only after validating it and approving cutover**.
   Use Cloudflare encrypted secrets and rotate/re-encrypt existing tokens as needed.
   Never copy the Supabase encryption key, encrypted tokens, password hashes, or JWT
   signing secrets into Git, logs, chat output or plaintext exports.
4. Review identity mapping for all authorized users, check developer/public seat
   assignment, and explicitly reconcile any connected account with no membership.
5. Build and test SQLite persistence adapters and WHOOP APIs using synthetic users
   first, including disabled users, attempted cross-user access, repeated imports,
   OAuth token refresh, and failure/rollback scenarios.
6. Only after those checks: conduct an encrypted, integrity-checked data transfer
   scoped to approved authorized users; verify row counts, ownership, chronology,
   data fidelity and WHOOP OAuth operation. Keep the Supabase source intact until
   the Cloudflare app is demonstrably equivalent and the owner approves shutdown.
7. The approved *target configuration* is Worker name `whoop-lens`, existing D1
   staging database, `workers_dev=false`, `preview_urls=false`, API flag false,
   with eventual custom domain `whooplens.tech`. The custom domain has NOT been
   bound to a Worker. Adding a custom domain/route or changing DNS is a
   separate, explicitly approved launch step. No DNS zone activation, registrar
   transfer, website/Worker deployment, Pages publication or change to existing
   ChatGPT MCP URLs during staging.

## Cost boundary

Target no additional recurring cost, use free allocations only. D1/Workers usage
limits and platform quotas must be confirmed before enabling live traffic. An
empty staging database is not a claim of a free unlimited production backend.

## Worker's current behavior

The NEW staged Worker version implements isolated read and future WHOOP OAuth routes but returns HTTP 503 while MIGRATION_API_ENABLED=false, and the two WHOOP flags are also false. This staged version is **uploaded but not deployed**. The existing Worker has a different, earlier deployment with no workers.dev or preview routing enabled. No authenticated WHOOP Lens Cloudflare endpoint is confirmed live.

## Rollback

Since Supabase was not changed, simply leave the existing service in place.
Delete/disable Cloudflare staging resources only by explicit approval.
Do not destroy source data, OAuth clients, tokens or sessions.


## OAuth sign-in and consent implementation checkpoint (2026-10-11)

- Added browser-bound OAuth consent using official beginConsent, approveConsent
  and denyConsent APIs; an explicit Allow/Deny form shows the client, scopes
  and redirect destination with strict HTML escaping and no framing.
- Transitional sign-in verifies credentials against the existing Supabase Auth
  endpoint and fetches the authenticated user again, then checks explicit
  active invited membership in Cloudflare D1. No credentials are persisted.
- D1 migration 0003 supplies atomic per-IP and per-email counters keyed
  by a secret HMAC to limit login attempts without storing those identifiers.
  The Cloudflare AUTH_RATE_HMAC_KEY and SUPABASE_PUBLIC_KEY are not configured
  or copied; missing configuration denies sign-in.
- This remains a CODE-ONLY staging implementation: both
  OAUTH_SERVER_ENABLED=false and OAUTH_CONSENT_ENABLED=false, no Worker deploy,
  no DNS/WHOOP redirect change, and no real users or credentials copied.
- Before private end-to-end testing, review Cloudflare collection of
  password submissions, rate-limit counter retention and failure modes,
  remaining identity migration design, and consent/PKCE token conformance.
  See cloudflare/oauth/ARCHITECTURE.md for details.



## Redirect-based OAuth design replacing the staged password form

The subsequent draft OAuth batch **replaces**, rather than enables, the
earlier disabled Cloudflare-hosted password form. The Auth Worker now uses
official OAuth \`beginConsent\` / \`approveConsent\` / \`beginUpstream\` and
\`finishUpstream\` helpers and a browser redirect to the project's existing
Supabase OAuth 2.1 authorization endpoint with S256 PKCE. The return code
is exchanged at the fixed Supabase OAuth token endpoint and the resulting
subject is verified with Supabase Auth plus ACTIVE D1 membership. Supabase
tokens are not copied into Cloudflare grants. Local logout is required.

The old password module and its tests are removed. Any historical checkpoint
above describing a transitional password form is superseded by this section.
This remains **undelployed staging source**, with both OAuth gates disabled,
public/preview URLs disabled, no new routes/domains, no registered upstream
OAuth client, no Supabase production changes and no real data transfer.
Supabase retains the active WHOOP Lens service.

The exact future OAuth callback
\`https://auth.whooplens.tech/oauth/upstream/callback\` must be registered in
Supabase only following a separate owner-approved, threat-reviewed step.
Supabase OAuth configuration, login UI and token/logout conformance are
unverified for this future client. See \`cloudflare/oauth/ARCHITECTURE.md\`.


## Mandatory membership and identity transfer preflight (code only)

- \`cloudflare/migration/preflight.mjs\` is a **pure, zero-write** validator for
  a controlled future migration manifest. The manifest contains only stable
  user IDs, approved membership flags, seat roles and record-owner IDs;
  raw WHOOP health data, email addresses, encrypted refresh tokens, password
  material and arbitrary record fields are rejected.
- The preflight checks Supabase Auth identities, exact \`identity_links\`
  provider-to-subject relationships, explicit ACTIVE member rows, each WHOOP
  connection, each recovery/sleep record owner and the 9-public/1-developer
  seat limits. It also rejects duplicates and unmapped or inactive users.
- Only aggregate **finding codes and counts**, never account IDs, are returned.
  \`requireSafeTransferManifest()\` throws if ANY reconciliation problem exists.
  Passing this check still **does not authorize data movement or deployment**.
- The live Supabase read-only audit identified a connected account without an
  explicit member row. No automatic membership enrollment is allowed. That
  account requires owner-reviewed, policy-grounded reconciliation before
  creating a real transfer manifest.
- Before even considering a transfer, `requireSafeTransferManifest()` now
  requires independently supplied, scope-matched **expected source counts**
  for all eight aggregate categories. Omitted totals, any mismatched count,
  or a zero-connection source snapshot **fail closed**. Counting the manifest
  itself is NOT independent verification; the owner must review the read-only
  source snapshot separately. Passing still does not authorize a cutover.
- The validator is covered by synthetic tests in the existing Cloudflare
  isolation workflow. All real account and health data remain in Supabase.
  No credentials, identity rows, recovery/sleep records or OAuth grants were
  copied to D1 by this preflight work.


## 2026-10-11 domain and MCP checkpoint

This checkpoint supersedes historical undeployed/domain-free statements above.
The owner authorized Cloudflare deployment and domain wiring while preserving
Supabase. The free Cloudflare zone is active and custom domains map
`whooplens.tech` to the resource Worker and `auth.whooplens.tech` to the issuer.
Both Workers are deployed with activation gates false, workers.dev/preview
URLs disabled and request observability disabled. Supabase remains live; no
production identity, health record, OAuth grant or credential was copied.

The next batch adds Samsung Health, Health Connect, reviewed medical context,
capability discovery and WHOOP connection to the six WHOOP read tools (11
total). Reads bind the verified owner, require active membership, validate
arguments and paginate deterministically. Migration 0004 requires an explicit
review timestamp before medical context can be returned. `connect_whoop` is
correctly annotated as a state-writing operation. The WHOOP callback uses its
own consumed OAuth state; MCP bearer validation still protects other paths.

128 local tests pass, including real-provider OAuth tests with synthetic
identities and SQLite tenant-isolation tests. Both Worker dry-run builds pass.
A live browser check encountered `ERR_BLOCKED_BY_CLIENT`; browser sign-in is
not yet verified.

Activation still needs a dedicated upstream Supabase OAuth client with the
exact Cloudflare callback, the source-prepared login UI callback allowlist
change, and WHOOP application credentials/callback registration. These are
not configured in production. Source membership reconciliation is also
required before transferring real records; missing memberships are not
automatically granted. Keep Supabase live until the owner verifies Cloudflare.


## Superseding independent authentication checkpoint (2026-10-11)

Cloudflare Access now replaces the transitional Supabase upstream adapter.
See `cloudflare/oauth/CUTOVER.md` for the independent runtime, exact Access
configuration, identity mapping, deferred verification and owner approval gates.
Historical Supabase upstream-client setup instructions no longer apply.
The old adapter exists only as a test fixture for protocol regression coverage.
The legacy root staging entrypoint remains separate; deploy the OAuth issuer
and resource configurations, which contain no Supabase network endpoints.
All launch flags stay false. Supabase remains live until the owner authorizes
cutover and later retirement; passing checks does not authorize either.
