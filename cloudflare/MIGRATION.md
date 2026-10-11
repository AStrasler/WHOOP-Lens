# WHOOP Lens: Supabase to Cloudflare migration

Status: **Cloudflare D1 staging schema created, app not migrated or published**.
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

The source shell in src/index.js deliberately returns HTTP 503 to all routes.
workers_dev=false and preview_urls=false prevent default public Worker addresses,
but a later custom-route configuration could expose it if not separately reviewed.
The Worker has **not** been deployed. No authenticated API functionality exists
on Cloudflare yet.

## Rollback

Since Supabase was not changed, simply leave the existing service in place.
Delete/disable Cloudflare staging resources only by explicit approval.
Do not destroy source data, OAuth clients, tokens or sessions.
