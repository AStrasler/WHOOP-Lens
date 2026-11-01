# MCP-first feature parity — implementation workstream

Status: **not complete.** The MCP requirements are implemented and tested; the website settings requirement is blocked on an owner decision (see audit). Do not close #121 until that decision is made and carried out, or the requirement is formally dropped.

## Original acceptance criteria (from #121) vs this PR

| # | Original requirement | State | Evidence |
| --- | --- | --- | --- |
| 1a | `set_life_schedule` accepts only the reviewed values | Done | `fixed`/`flexible`/`unpredictable` enum; exact-keys validation (`lifeScheduleWriteArguments`) |
| 1b | Writes only for the authenticated member | Done | `userId` comes from the verified identity, never an argument; `user_id` argument rejected; SQL binds the verified ID |
| 1c | Explicit user request only; never inferred | Done | Required confirmation constant, tool description and host instructions; inferred/reason fields rejected |
| 1d | Gated by `LIFE_SCHEDULE_ENABLED` | Done | Not listed and not callable when off |
| 1e | Tests: isolation, invalid values, feature off, missing schema, revoked session | Done | `life-schedule.test.mjs`: handler-level tests, plus an end-to-end `/mcp` route test where a revoked grant (401), missing session (401) and inactive member (403) write nothing; mid-write revocation fence test |
| 2 | Website view/edit of Life Schedule | **Blocked** | The site has no member sign-in; adding one is an auth change, which #121's constraints exclude. Owner decision required |
| 3 | Parity audit; follow-ups for other app-only gaps | Done | `mcp-parity-audit.md`. The two companion-sync gaps the audit found were built here (`get_companion_sync_status`, `pause_companion_sync`) at the owner's direction on Nov 1, 2026, instead of separate follow-ups. They are self-contained and can be split into their own PR if preferred |
| C | No auth change, no 0021, no Android permission change, no paid services | Met | MCP tools only; no migration; no Android change in this PR |

## Principle

WHOOP Lens is **MCP-first, with Android optional**. A member using only MCP must be able to access every feature that does not physically require a phone. Merely exposing read-only insights does not satisfy a user-editable setting.

## First implementation: Life Schedule

- [x] Discover the existing reviewed Life Schedule values and canonical preference storage. Do not introduce or infer new values. (`fixed`, `flexible`, `unpredictable` in `member_life_schedule`, via `selectLifeSchedule()`.)
- [x] Add an authenticated MCP `set_life_schedule` tool gated by `LIFE_SCHEDULE_ENABLED`.
- [x] Change only the signed-in member's value; preserve owner/member isolation and revocation fencing. (Same `selectLifeSchedule()` write as the app's settings route, including the active-membership fence in the SQL.)
- [x] Require an **explicit user instruction in the conversation**. Never infer or change a schedule from background data, patterns, a summary, or an AI suggestion. (Required confirmation constant, exact-keys validation, tool description and host instructions.)
- [ ] Add member-facing web view/edit of Life Schedule through the existing authenticated WHOOP Lens API; no new external service. **Blocked:** the website has no member sign-in, and adding one is an auth change this workstream excludes. Owner decision in `mcp-parity-audit.md`.
- [x] Ensure Android, web and MCP use one consistent member-owned value and keep the app optional. (MCP and the app's `/v1/preferences/life-schedule` read and write the same row; tested.)
- [x] Test valid/invalid values, other-member isolation, flag off, missing D1 schema, revoked session and authorization failures. (`cloudflare/test/life-schedule.test.mjs`, including the `/mcp` route with a revoked grant.)

## Broader parity audit

Record every Android feature as MCP-available, web-available, physically phone-required or still missing. Include preferences, consent views and sync status in the audit. Health Connect ingestion and Direct BLE require compatible phone hardware, but their member-visible status/controls should still be evaluated independently.

- [x] Inventory the actual app features against current main, citing source paths. See `docs/workstreams/mcp-parity-audit.md`.
- [x] Identify parity gaps; create dedicated follow-up work only when concrete gaps are confirmed. (Closed: Life Schedule write and capability discovery. Closed: companion sync status (`get_companion_sync_status`) and the non-destructive pause (`pause_companion_sync`). Blocked: web settings.)
- [x] Keep private data/access boundaries intact and do not expand Android permissions.

## Review/release boundary

- [ ] Exact-head-SHA independent Codex review.
- [ ] All applicable tests and GitHub CI green.
- [x] Document D1/API compatibility and non-destructive rollback. No migration: the tool uses the existing `member_life_schedule` table (0024). Rollback is the code release only; stored selections are untouched, and with the flag off the tool is neither listed nor callable.
- [ ] No OAuth cutover, no migration 0021, no paid service, and **no deployment without owner approval**.

Do not mark this workstream complete merely because the PR exists.
