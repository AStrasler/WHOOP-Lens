# Supabase retirement: verified data reconciliation (2026-10-23)

Status: BLOCKED ON PRODUCTION DATA CUTOVER. Do not delete the Supabase project.

Read-only counts verified against both live services:

| Table | Supabase | Cloudflare D1 |
|---|---:|---:|
| whoop_recovery | 14 | 0 |
| whoop_sleep | 14 | 0 |
| whoop_members | 1 | 3 |
| whoop_connections | 2 | 3 |
| samsung_health_records | 0 | Not yet compared |
| whoop_oauth_states | 4 | Not directly comparable |
| whoop_waitlist | 0 | Not yet compared |

The 28 WHOOP history rows are not in the corresponding D1 history tables. Before shutdown, export them securely, compare stable WHOOP IDs and mapped member UUIDs, then import idempotently with source provenance. Confirm 14/14 row-level parity and per-member isolation, not just aggregate counts. Do not copy legacy OAuth access/refresh tokens or expired authorization states blindly. The 3 existing Cloudflare members/connections must not be overwritten by the 1/2 legacy rows. Preserve the legacy database until validated backup and parity checks pass.

Live Cloudflare OAuth uses Cloudflare Access and D1 membership. Retired GitHub Pages workspace and unreleased Android companion still contain legacy Supabase authentication. Those clients must remain unpublished/unreleased or be replaced with supported Cloudflare OAuth clients before Supabase shutdown.

No production data writes, token exports, deployments, or deletions were authorized or performed as part of this report.
