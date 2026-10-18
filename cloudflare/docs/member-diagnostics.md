# Member diagnostics and issue reports

Off by default. Nothing is written to D1 until migration `0017_member_diagnostics.sql` is applied and the flags are exactly `"true"`.

| Flag | Effect |
|---|---|
| `DIAGNOSTICS_CAPTURE_ENABLED` | Sanitized failure and partial events are stored in `diagnostic_events`. Without it, events are only a sanitized console line with no member id, in the existing Workers logs. |
| `ISSUE_REPORTS_ENABLED` | Lists `report_issue` for members and `review_issue_reports` and `update_issue_report` for the owner only, and adds the report guidance to the host instructions. |

## Auto-captured events (`src/diagnostics.mjs`)
Each event has: category, subsystem, fixed code, outcome (`success`/`fail`/`partial`), retryable, timestamp, request id (`req_` plus 16 hex, generated for each request in `router.mjs`) and the member id when it is authenticated (`''` otherwise). Repeats in the same 10-minute window update one row (`count`). Error messages, bodies, headers, tokens, URLs and health values are never stored. Classification only matches error types and our own fixed message strings.

Sources: MCP tool errors and invalid arguments, WHOOP API, auth and 429s, AI summary failure and template fallback (with the fixed reason), Health Connect token issuance and storage errors, webhook outcomes (`hc_delivery_stored`, `hc_only_unsupported_types`, `hc_records_rejected`, `hc_empty_delivery`, token, consent, payload and rate-limit failures), the WHOOP callback, unauthenticated MCP calls, inactive membership and DB failures.

Retention: 30 days. Each write sweeps at most 50 expired rows.

## Member reports (`src/issue-reports.mjs`)
- `report_issue` takes `{category, description, confirm?}`. There is no member id argument; the member is the authenticated one.
- The first call (no `confirm`) only returns the cleaned text. The host must show it, and send `confirm: "submit-issue-report"` only after the member approves.
- Cleaning removes every number (health values, dates, phone numbers), email addresses, links, UUIDs, bearer, JWT and other token-like strings, and markup. 500 characters max.
- The write is one conditional `INSERT … ON CONFLICT` that also checks active membership and the limits: 1 per minute and 5 per day per member, 100 per day server-wide. Duplicates update the same reference. A resolved report that comes back becomes `recurring`.
- A `WL-XXXXXXXX` reference is returned only after the row is read back for this member and request. Every failure says "not submitted and no reference was created."
- Evidence attached: up to 10 of this member's own sanitized events from the last 24 hours.
- Resolved reports are purged 180 days after their last update.

## Owner oversight
`review_issue_reports` and `update_issue_report` are listed and callable only when `WHOOP_LENS_DEVELOPER_USER_ID` equals the caller (the `get_ai_usage` rule). Anyone else gets "Unknown tool".
- `review_issue_reports` shows severity, category, status, subsystems, occurrences, sanitized evidence and server-wide event counts for the last day, without member ids.
- `update_issue_report` only sets the status: new, acknowledged, resolved or recurring.

Nothing in this feature runs commands, deploys, rotates credentials or changes permissions.

## Deploy requirements (not done here)
1. Apply `0017_member_diagnostics.sql`. Rollback: `migration/rollback/0017_member_diagnostics.down.sql`, after turning both flags off.
2. Deploy the resource worker.
3. Set the flags.

No new service, binding or secret is needed.
