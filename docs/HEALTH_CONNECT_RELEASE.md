# WhoopLens private Health Connect release gate

**Status: review only. No production migration, function deployment, user-data import or app rollout authorized by this document.**

## Implementation chain

- PR #8 provides WhoopLens capability/limitation discovery.
- PR #9 adds compatible Samsung v1 and new Health Connect v2 ingestion plus read-only MCP.
- PR #10 adds source-attributed private medical-context functionality.
- PR #11 adds the Android companion and a release-gated reviewed **steps-only** v2 export/delete workflow.

These are **stacked draft branches**, not separately deployable as though they had all been merged into main.

## Preflight checks (no production mutations)

1. Reconfirm WhoopLens is private, invite-only, and the known authorized beta users and developer seat remain correct.
2. Review Supabase Free project quota, edge logs, Auth policy and security/performance advisors. Do not assume that a free tier is unlimited.
3. Run Node tests and Android compile workflow. Confirm both succeed on the **exact proposed release commit**.
4. Confirm the separate Health Connect PostgreSQL smoke workflow passes, including owner-only authenticated SELECT, no direct inserts/updates/deletes, and repeat-key upsert behavior. CI uses **disposable Postgres**, not live Supabase.
5. Review the migration at supabase/migrations/20261011115000_health_connect_records.sql and the entire effective set of stacked PRs. The prior Samsung v1 table and existing WHOOP credentials must remain untouched.
6. Verify no Android package contains service-role keys, refresh tokens from WHOOP, private user identifiers or publicly distributable beta credentials.

## Explicit owner approval is required for the following production steps

1. Apply the **reviewed additive** Health Connect migration to the existing Supabase project. It creates a per-user table and grants only authenticated owner SELECT and authenticated-server-service writes. Never apply to an unverified project.
2. Recheck SQL grants, owner RLS, security advisor findings, quota and existing Samsung v1 behavior against live infrastructure without disclosing private health values in logs.
3. Deploy updated samsung-health v2 and whoop-mcp functions **only after approved review**. Preserve legacy Samsung v1 behavior and all WHOOP member/seat checks. Test with synthetic records scoped to explicitly authorized users.
4. Validate authenticated manual upload, replay correction, user isolation, and user-directed deletion for a synthetic day. A second authorized user must see no records owned by the first.
5. Only then enable ManualSync.ENABLE_UPLOADS in a separately reviewed Android build and distribute it privately to specifically invited testers. Require explicit per-user Health Connect permission and review/confirmation before each upload.
6. Validate actual Galaxy Health Connect permissions, denied/revoked access, timing/date zones and multi-source step aggregation. No automatic background sync.

## Release scope and limits

Initial syncing is **one selected local yesterday steps aggregate per review and upload action**. Sleep, heart rate and exercise offer bounded local previews only. A count cap of 50 is not an exhaustive measure of total records. No medical diagnoses, medical-record imports, provider/EHR writes, or long-term goal persistence are part of this release. User-selected day deletion affects only the corresponding uploaded Health Connect steps record for that signed-in account, not the source phone data.

No public enrollment, app marketplace release, credential copying across users, unbounded recording or continuous syncing is authorized.

## Rollback

- If Android is not approved or testing fails, leave the upload feature OFF. Existing WhoopLens use remains unchanged.
- If v2 ingestion has a problem, disable upload on Android and restore the reviewed older Edge Function code while retaining database rows for user-controlled cleanup.
- Never DROP the new table as an automatic rollback: removing it would delete privately uploaded records. Any retention/delete operation must receive separate approval.
- Re-run owner-isolation tests after corrective redeployment. Do not claim that a passing CI smoke test alone establishes the live production grants.

**Release approval requires the project owner to review this precise production change; passing tests is not authorization.**
