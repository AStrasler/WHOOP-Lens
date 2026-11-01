# MCP-first feature parity — implementation workstream

Status: **draft / implementation not yet complete**. Converted from issue #121; its full description and prior discussion are retained in the pull request.

## Principle

WHOOP Lens is **MCP-first, with Android optional**. A member using only MCP must be able to access every feature that does not physically require a phone. Merely exposing read-only insights does not satisfy a user-editable setting.

## First implementation: Life Schedule

- [ ] Discover the existing reviewed Life Schedule values and canonical preference storage. Do not introduce or infer new values.
- [ ] Add an authenticated MCP `set_life_schedule` tool gated by `LIFE_SCHEDULE_ENABLED`.
- [ ] Change only the signed-in member's value; preserve owner/member isolation and revocation fencing.
- [ ] Require an **explicit user instruction in the conversation**. Never infer or change a schedule from background data, patterns, a summary, or an AI suggestion.
- [ ] Add member-facing web view/edit of Life Schedule through the existing authenticated WHOOP Lens API; no new external service.
- [ ] Ensure Android, web and MCP use one consistent member-owned value and keep the app optional.
- [ ] Test valid/invalid values, other-member isolation, flag off, missing D1 schema, revoked session and authorization failures.

## Broader parity audit

Record every Android feature as MCP-available, web-available, physically phone-required or still missing. Include preferences, consent views and sync status in the audit. Health Connect ingestion and Direct BLE require compatible phone hardware, but their member-visible status/controls should still be evaluated independently.

- [ ] Inventory the actual app features against current main, citing source paths.
- [ ] Identify parity gaps; create dedicated follow-up work only when concrete gaps are confirmed.
- [ ] Keep private data/access boundaries intact and do not expand Android permissions.

## Review/release boundary

- [ ] Exact-head-SHA independent Codex review.
- [ ] All applicable tests and GitHub CI green.
- [ ] Document D1/API compatibility and non-destructive rollback.
- [ ] No OAuth cutover, no migration 0021, no paid service, and **no deployment without owner approval**.

Do not mark this workstream complete merely because the PR exists.
