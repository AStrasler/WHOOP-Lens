# MCP-first feature parity — implementation workstream

Status: **MCP implementation complete in this PR; website editing blocked on an owner decision (see audit)**. Converted from issue #121; its full description and prior discussion are retained in the pull request.

## Principle

WHOOP Lens is **MCP-first, with Android optional**. A member using only MCP must be able to access every feature that does not physically require a phone. Merely exposing read-only insights does not satisfy a user-editable setting.

## First implementation: Life Schedule

- [x] Discover the existing reviewed Life Schedule values and canonical preference storage. Do not introduce or infer new values. (`fixed`, `flexible`, `unpredictable` in `member_life_schedule`, via `selectLifeSchedule()`.)
- [x] Add an authenticated MCP `set_life_schedule` tool gated by `LIFE_SCHEDULE_ENABLED`.
- [x] Change only the signed-in member's value; preserve owner/member isolation and revocation fencing. (Same `selectLifeSchedule()` write as the app's settings route, including the active-membership fence in the SQL.)
- [x] Require an **explicit user instruction in the conversation**. Never infer or change a schedule from background data, patterns, a summary, or an AI suggestion. (Required confirmation constant, exact-keys validation, tool description and host instructions.)
- [ ] Add member-facing web view/edit of Life Schedule through the existing authenticated WHOOP Lens API; no new external service. **Blocked:** the website has no member sign-in, and adding one is an auth change this workstream excludes. Owner decision in `mcp-parity-audit.md`.
- [x] Ensure Android, web and MCP use one consistent member-owned value and keep the app optional. (MCP and the app's `/v1/preferences/life-schedule` read and write the same row; tested.)
- [x] Test valid/invalid values, other-member isolation, flag off, missing D1 schema, revoked session and authorization failures. (`cloudflare/test/life-schedule.test.mjs`.)

## Broader parity audit

Record every Android feature as MCP-available, web-available, physically phone-required or still missing. Include preferences, consent views and sync status in the audit. Health Connect ingestion and Direct BLE require compatible phone hardware, but their member-visible status/controls should still be evaluated independently.

- [x] Inventory the actual app features against current main, citing source paths. See `docs/workstreams/mcp-parity-audit.md`.
- [x] Identify parity gaps; create dedicated follow-up work only when concrete gaps are confirmed. (Closed: Life Schedule write and capability discovery. Follow-up gaps: read-only companion sync status and a confirmed non-destructive `pause_companion_sync`. Blocked: web settings.)
- [x] Keep private data/access boundaries intact and do not expand Android permissions.

## Review/release boundary

- [ ] Exact-head-SHA independent Codex review.
- [ ] All applicable tests and GitHub CI green.
- [x] Document D1/API compatibility and non-destructive rollback. No migration: the tool uses the existing `member_life_schedule` table (0024). Rollback is the code release only; stored selections are untouched, and with the flag off the tool is neither listed nor callable.
- [ ] No OAuth cutover, no migration 0021, no paid service, and **no deployment without owner approval**.

Do not mark this workstream complete merely because the PR exists.
