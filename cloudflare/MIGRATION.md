# WHOOP Lens: Supabase to Cloudflare migration

Status: **Supabase remains PRIMARY; Cloudflare is PARALLEL STAGING only. No application deployment, domain cutover or live data copy.**
Cloudflare account: dedicated WHOOP Lens account.
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
7. No DNS zone activation, WHOOP domain registrar transfer, website deployment,
   Cloudflare Worker deployment, Pages publication, or change to existing
   chatgpt-mcp URLs during staging. DNS and domain migration are separate projects.

## Cost boundary

Target no additional recurring cost, use free allocations only. D1/Workers usage
limits and platform quotas must be confirmed before enabling live traffic. An
empty staging database is not a claim of a free unlimited production backend.

## Worker's current behavior

The staged Worker implements restricted read routes but **returns HTTP 503** to all requests while MIGRATION_API_ENABLED=false. workers_dev=false and preview_urls=false disable default public addresses; a future custom route still requires separate security review. The Worker has **not** been deployed, and no authenticated endpoint is live on Cloudflare yet.

## Rollback

Since Supabase was not changed, simply leave the existing service in place.
Delete/disable Cloudflare staging resources only by explicit approval.
Do not destroy source data, OAuth clients, tokens or sessions.
