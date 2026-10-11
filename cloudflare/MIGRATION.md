# WHOOP Lens: Supabase to Cloudflare migration

Status: **Supabase remains PRIMARY; Cloudflare is PARALLEL STAGING only.** An existing Cloudflare Worker deployment was discovered on 2026-10-11, but OUR tested staging version has been UPLOADED ONLY, NOT DEPLOYED. No domain cutover or live data copy.
Cloudflare account: dedicated WHOOP Lens account.
Cloudflare Worker name (planned, not deployed): `whoop-lens`.
Custom domain target (reserved, not attached): `whooplens.tech`.
Default workers.dev and preview URLs: disabled in configuration.
API runtime flag: `MIGRATION_API_ENABLED=false`; no public API.
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
