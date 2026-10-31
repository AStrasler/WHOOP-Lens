# Companion beta.2 activation gates

Development adds an authenticated companion sync protocol (`sync_protocol:1`) around existing Health Connect v2 imports and Life Schedule activation diagnostics. No production change is authorized by this document.

Read-only inspection on 2026-10-31 found WEB_HEALTH_IMPORT_ENABLED=true, no LIFE_SCHEDULE_ENABLED binding, and no `health_import_fences` or `member_life_schedule` table in the live DB bound to whoop-lens. Records/consent tables already exist. No member data or credentials were inspected.

## Nonproduction verification

`node --test cloudflare/test/companion-sync.test.mjs cloudflare/test/health-import.test.mjs cloudflare/test/life-schedule.test.mjs` uses synthetic in-memory SQLite. It covers four reviewed categories, explicit consent, caller-derived identity, retries/upserts, per-user last sync, pause with data retention, token revocation, pending-write fencing, withdrawal isolation, inactive members, feature-off and missing-schema states, and Life Schedule persistence/defaults/insights. Existing OAuth-provider CI validates the resource wrapper and bundles both Workers without deployment.

The Android client only enables its reviewed upload action after authenticated GET `/v1/health-connect/sync-status` reports protocol 1. Older deployments and missing lifecycle schema do not qualify. Dashboard/background refresh never uploads. The supported categories match the existing server contract: daily steps aggregates, heart-rate samples, sleep sessions (recorded asleep duration), and exercise sessions. Category choice does not grant consent; each bounded preview requires an explicit upload action. Pause revokes future ingestion without removing stored rows. Withdrawal deletes the caller's cloud Health Connect copy and revokes ingestion. Neither changes phone records or WHOOP data.

## Exact owner approvals required before physical activation

1. Approve a production maintenance window for the resource Worker `whoop-lens` and database `whoop-lens-migration` (id `58250de2-cad7-4a8a-a061-d9b41c7b24d2`). Reconcile actual deployed version/configuration and schema immediately before work.
2. Approve pausing Health Connect ingestion, draining old in-flight writes, backing up the database, and applying reviewed migrations **0022**, then **0023**. Verify `health_import_fences`, `health_connect_member_deactivated` and `health_connect_member_removed`. These are necessary for revocation protections; do not bypass them to make the client appear active. Review existing 0007 token storage as a prerequisite. This does not authorize OAuth-store migration/cutover 0021.
3. Approve applying **0024** for `member_life_schedule`. Do not backfill inferred choices. Unset/invalid reads resolve to unpredictable without writing.
4. Approve a code-only release of the reviewed resource Worker preserving all current secrets, service/D1 bindings, routes, cron and existing controls. Review the existing release-worker-content path; do not replace live configuration with staged JSONC defaults. Verify in a nonproduction environment first.
5. Approve WEB_HEALTH_IMPORT_ENABLED=true for the reviewed protocol and LIFE_SCHEDULE_ENABLED=true. Verify authenticated readiness, 401/403 failure boundaries, isolated status, default preference reads and owner-controlled preference persistence. Readiness does not authorize a health upload; the owner must separately select categories and confirm an exact preview in the app.

Rollback: disable feature flags and stop new admissions first. Restore reviewed compatible code; retain Health Connect lifecycle fences, revocation tombstones and saved preferences. Do not revert the OAuth store or resurrect credentials. A later schema rollback requires a separate reviewed decision after compatible code is active; data loss is not an incidental rollback step.

Release/signing/publication of Android 0.6.0-beta.2 is a separate approval. This development work does not apply production migrations, deploy a Worker, enable flags, upload member health data, alter real preferences, or publish a live notice.
