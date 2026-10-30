# Service announcements activation — deferred rollout checklist

**Status: planning only.** This document opens a draft PR so work can resume later. It does not authorize applying migrations, changing Worker bindings, deploying, sending notices, or merging this PR.

## Starting point (October 30, 2026)

- The existing `cloudflare/src/announcements.mjs` code supports owner-only create/update/manage and member-visible notice listing via authenticated MCP and HTTP.
- `cloudflare/migrations/0020_service_announcements.sql` defines `service_announcements` and `service_announcement_targets`.
- The live D1 database was checked read-only: neither table existed. The authenticated WHOOP Lens connector did not advertise announcement tools or the announcement feature. The test notice **ABC 123 has not been published**.
- The committed configuration defaults `ANNOUNCEMENTS_ENABLED` to `"false"`. A Git merge is not a deployment or feature activation.
- Existing implementation reference: `cloudflare/docs/service-announcements.md`.

## Proposed work (not started)

- [ ] Confirm the production Worker version, live announcement flag, and current migration state; reconcile these with the repository.
- [ ] Review the existing owner-only authorization, member visibility, time/status handling, text validation, privacy boundaries, and Android presentation; run announcement tests and applicable full CI.
- [ ] Produce a release checklist, rollback sequence, and exact owner approval gates for applying **0020** to production D1, releasing the Worker through the existing code-only path, and then enabling `ANNOUNCEMENTS_ENABLED=true`.
- [ ] **Only after explicit separate owner approval:** execute the migration and Worker rollout in the correct order, verifying availability and continued authentication. Do not activate this feature merely by merging a PR.
- [ ] **Only after explicit separate owner approval and confirmed active feature:** publish a short-lived test announcement, using the approved owner-only route/tool, with `kind=update`, `audience=all`, `title=Test notice`, and **`body=ABC 123`**. Set `starts_at` to the actual publishing time; do not invent a past or future timestamp.
- [ ] Read it back using `list_service_announcements` and the authenticated `GET /v1/announcements` route; confirm the id, body, visible audience, and timing. Record the result without personal data.
- [ ] Discuss expiring/cancelling the test notice with the owner after verification; do not assume permission to retract it.

## Operational boundaries

- No Cloudflare D1 writes, migrations, flag changes, Worker deployment, account/seat modifications, or member notifications are part of this planning-only draft.
- Do not touch WHOOP authorization, Health Connect records, unrelated OAuth cutover work, or migrations 0021–0023.
- All owner actions must use existing authenticated endpoints; never bypass owner authorization by inserting a notice directly into D1.
- No push notification delivery is requested or authorized.

## Test success condition

After a separately approved activation, the owner-only create action returns an id; the member-visible read endpoint returns the same active notice with body **ABC 123**. If the feature remains disabled or the table is missing, report that honestly rather than claiming a successful test.
