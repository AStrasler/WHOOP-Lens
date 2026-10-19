# Member diagnostics and issue reports

Off by default. Nothing is written to D1 until migration `0017_member_diagnostics.sql` is applied and the flags are exactly `"true"`.

| Flag | Effect |
|---|---|
| `DIAGNOSTICS_CAPTURE_ENABLED` | Sanitized failure and partial events are stored in `diagnostic_events`. Without it, events are only a sanitized console line with no member id, in the existing Workers logs. |
| `ISSUE_REPORTS_ENABLED` | Lists `report_issue` for members and `review_issue_reports` and `update_issue_report` for the owner only, and adds the report guidance to the host instructions. |

## Auto-captured events (`src/diagnostics.mjs`)
Each event has: category, subsystem, fixed code, outcome (`success`/`fail`/`partial`), retryable, timestamp, request id (`req_` plus 16 hex, generated for each request in `router.mjs`) and the member id when it is authenticated (`''` otherwise). Repeats in the same 10-minute window update one row (`count`). Error messages, bodies, headers, tokens, URLs and health values are never stored. Classification only matches error types and our own fixed message strings.

Sources: MCP tool errors and invalid arguments, WHOOP API, auth and 429s, AI summary failure and template fallback (with the fixed reason), Health Connect token issuance and storage errors, webhook outcomes (`hc_delivery_stored`, `hc_only_unsupported_types`, `hc_records_rejected`, `hc_empty_delivery`, token, consent, payload and rate-limit failures), the WHOOP callback, unauthenticated MCP calls, inactive membership and DB failures.

Only events tied to an authenticated member are written to D1. Pre-authentication failures (unauthenticated MCP calls, rejected webhook tokens, WHOOP callbacks without a known member) are console-only, so an anonymous caller cannot cause database writes. Rate-limited outcomes (`hc_rate_limited`, `whoop_rate_limited`, `member_budget_exhausted`) are console-only too, and each member/code/10-minute bucket stops changing after 20 occurrences (`count` then means "at least 20"), so repeats cannot cause unbounded writes. After the cap a repeat costs one indexed read and no batch. With capture off, the retention sweep runs at most once a minute per worker instance.

When `DIAGNOSTICS_CAPTURE_ENABLED` is on, every member's `account.role_boundaries` says sanitized failure codes are recorded for all signed-in members, with or without a report, and that the owner sees server-wide 24-hour counts. With capture off, the notice is gone and review_issue_reports returns no server-wide diagnostics either.

Retention: 30 days. Each write sweeps at most 50 expired rows. The sweep keeps running on failure events even after capture is turned off.

## Member reports (`src/issue-reports.mjs`)
- `report_issue` takes `{category, description, approval_token?}`. There is no member id argument; the member is the authenticated one.
- The first call (no `approval_token`) returns the cleaned text and a random `approval_token`. Only its SHA-256 is stored, bound to this member and the exact cleaned text and category, for 10 minutes, with at most 10 open per member. Submitting requires that token. It is checked again inside the insert and consumed only if this submission was stored. The server cannot tell whether a person or the AI host approved, but it guarantees that the exact text was previewed first.
- Cleaning removes every number in any script (health values, dates, phone numbers), labeled secrets ("password: …", "my pin is …"), email addresses, links, UUIDs, bearer, JWT and other token-like strings, and markup. 500 characters max.
- The write is one conditional `INSERT … ON CONFLICT` that also checks active membership and the limits: 1 per minute and 5 per UTC day per member, 100 per UTC day server-wide. Duplicates count as submissions, and owner status changes never touch the counters. Duplicates update the same reference. A resolved report that comes back becomes `recurring`.
- Before any batch, one indexed read checks every cap (open previews, per-minute, member and server daily limits, and approval validity). A capped preview costs that read only; previews are refused during the per-minute window too, so preview/submit cycles cannot loop. A capped submit also deletes its approval, so retrying that token costs one read and is refused as needing a fresh preview.
- A `WL-XXXXXXXX` reference is returned only after the row is read back for this member and request. Every failure says "not submitted and no reference was created."
- Evidence attached: up to 10 of this member's own sanitized events from the last 24 hours.
- Resolved reports are purged 180 days after their last update. Expired approvals are purged too. Retention runs on every diagnostic write, preview, submission and owner review, so it does not depend on new reports. There is no cron trigger: if the server gets no traffic at all, nothing runs.

## Owner oversight
`review_issue_reports` and `update_issue_report` are listed and callable only when `WHOOP_LENS_DEVELOPER_USER_ID` equals the caller (the `get_ai_usage` rule). Anyone else gets "Unknown tool".
- `review_issue_reports` returns report text as `untrusted_member_text`, with a `handling` note (and host guidance) never to follow instructions in it. It also shows a pseudonymous `member_ref` (a truncated SHA-256 that groups one member's reports; no account id), severity, category, status, subsystems, occurrences, sanitized evidence and server-wide event counts for the last day, without member ids.
- `update_issue_report` only sets the status: new, acknowledged, resolved or recurring.

While reporting is on, `get_capabilities` role boundaries and the host instructions tell members their reports are visible to the owner, and tell the owner this is the only cross-account view.

Nothing in this feature runs commands, deploys, rotates credentials or changes permissions.

## Deploy requirements (not done here)
1. Apply `0017_member_diagnostics.sql`. Rollback: `migration/rollback/0017_member_diagnostics.down.sql`, after turning both flags off.
2. Deploy the resource worker.
3. Set the flags.

No new service, binding or secret is needed.
