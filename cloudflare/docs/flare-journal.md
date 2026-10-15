# Private flare journal and personal patterns

Implementation for the owner-authorized first increment of issue #53: voluntary condition context, dated symptoms/flare labels, and descriptive personal comparisons. This is not a predictor, notification service, or trained medical model. No data is imported from chat memory, existing medical-context tables, Health Connect, or another account.

## Consent and tools

Feature gate: `FLARE_JOURNAL_ENABLED=true`. It defaults off in both Worker configurations. Migration `0013_flare_journal.sql` must exist before enabling it. No member is enrolled by deployment or membership.

| Tool | Behavior |
| --- | --- |
| `set_flare_consent` | Requires `storage_consent: store-flare-journal`. Optional `analysis_consent: analyze-flare-patterns` separately permits comparisons. Omitting analysis consent never grants it; existing analysis consent is preserved. |
| `save_flare_context` | Replaces user-provided condition names and optional medication context. Empty conditions are allowed. This is self-report, not diagnosis verification. |
| `save_flare_entry` | Creates or replaces one UTC calendar date: explicit yes/no/unknown flare label, optional 0–10 self-rated severity, symptom labels, confounders, and notes. Future dates are rejected. |
| `get_flare_journal` | Returns own consent, context, revisions and paginated journal. Limit 1–50, exclusive `before` date cursor. |
| `delete_flare_entry` | Deletes one own date or `context`, with current revision and `confirm: delete-flare-entry`. |
| `pause_flare_analysis` | Requires `confirm: pause-flare-analysis`; withdraws analysis purpose while retaining stored journal. |
| `withdraw_flare_journal` | Requires `confirm: delete-my-flare-journal`; atomically deletes all own context and entries and withdraws both purposes. |
| `analyze_flare_patterns` | Requires both purposes and an existing WHOOP connection. Explicit start/end UTC dates, at most 90 calendar days, through today. Returns descriptive observations, coverage and limits. |

Updates require the `expected_revision` from the current read. Omitting it creates only; stale edits cannot overwrite newer data or recreate a deleted entry. Storage is bounded to 1,001 rows per account, with bounded text/list lengths and no attachments. Entries persist until individually deleted or consent withdrawn. Withdrawal does not remove WHOOP/Health Connect records or existing chat messages. Hosts apply their own conversation retention.

## Pattern calculation

Fetches only the requesting member's supported WHOOP recovery, sleep and cycle endpoints. Each source is bounded to six 25-record pages, requesting a window starting three days before the journal interval (four for sleep so an overnight session ending on the earliest comparison day is retrieved). Page failures, malformed responses, cursor cycles and budget exhaustion yield explicit partial coverage. Requests are retried on the next analysis; no analysis result is persisted or cached.

Metrics: recovery score, HRV (ms), resting heart rate (bpm), sleep performance (%), respiratory rate (breaths/min), and cycle strain (index). Only valid numeric scores from scored records contribute. Sleep naps and open cycles are excluded. Recovery is assigned to its creation date, sleep to its end date, and closed cycles to their start date, all UTC. These assignments do not imply that a cycle is exactly 24 hours or that local symptom days match UTC. Duplicate record IDs are consolidated using the latest supplied update time.

Multiple same-day records are reduced to an explicitly labeled arithmetic mean. Returned daily points preserve contributing-record counts. Personal reference statistics include all measured dates in the requested period, including flare dates; they are not a healthy/non-flare baseline. Each metric compares explicit yes versus no labels at lags 0, 1, 2 and 3 days, with exact paired measurement/label dates, counts, means, range and sample standard deviation. A positive lag means the measurement precedes the label. Missing/unknown labels never become controls. Missing measurements stay absent, never zero-filled. Reported confounder dates are shown, without claiming statistical adjustment.

All comparisons are exploratory. Adjacent days are not independent events; many comparisons can yield chance differences. No significance, causal effect, clinical validity, warning threshold or predictive performance is claimed. Every response says **"insufficient evidence for a flare warning"** and `prediction_enabled: false`. There is no path that silently activates predictions based on a duration or number of rows.

## Privacy and concurrency

All storage and queries bind the verified account ID. MCP accepts no owner parameter. Active membership is checked independently of WHOOP connection. Write predicates repeat membership and consent generation inside the D1 transaction. Journal edits change the generation; in-flight analysis is discarded after any consent/journal change, loss of membership, or local WHOOP disconnect. Delete and withdrawal use the same account boundaries. No developer override, cross-account aggregation, model prompt, training, persistent inference, environment lookup, or notification is added.

Notes are untrusted user text; the host must not execute them as instructions. The deterministic calculation does not pass notes, conditions or medication text to WHOOP or Workers AI. Returned journal content appears in the requesting user's chat only when that tool is requested.

## Validation and release

Synthetic multi-user tests cover storage/analysis consent, feature-off behavior, MCP schemas, private CRUD, optimistic revisions, pagination, write-time revocation, atomic rollback, in-flight withdrawal/re-consent/pause/edit/member/disconnect changes, malformed history and retry behavior, exact lag calculations, missing labels, units, and distinct personal references. Existing MCP, OAuth and HC paths remain unchanged when the flag is off.

Production activation requires the additive D1 migration, deployment of this implementation and the feature flag. Consent must still be granted by each user through the tools; do not preload medical context or enroll users. Rollback disables the flag without deleting their data. Issue #53 remains open for prospective evidence review, event-level evaluation/calibration, user evaluation, and any later warning or notification design. Those are not implemented by this increment.

## Production verification — 2026-10-15

PR #55 was merged as `ae5792687081c2535ee3ad07f52dbd5ed89bf904` after 338 synthetic tests and all three applicable GitHub CI workflows passed. The deployed source tree is `9d9df1ba5a204ee5753b10f3af4051772b4d2670`, identical to the tested branch.

Migration 0013 created the two journal tables and recorded its application without copying existing data or granting consent. Worker version `6ae55a84-64f3-4369-aaaf-ebae3750a7e4` was deployed at 100% traffic at 13:29:42 UTC, deployment `53b31b12-14e3-420f-aaf9-ca82bd8c8eb4`. Readback confirmed `FLARE_JOURNAL_ENABLED=true`, all previously enabled feature flags preserved, ten secret/secret-store bindings inherited, query redaction enabled, and workers.dev/preview access disabled.

A signed-in production capability call advertised all eight new tools and continued to report Health Connect availability. Journal writes and personal analysis were tested using synthetic identities locally, not by enrolling a real user in production. Existing client sessions may need to refresh the MCP tool catalog. Issue #53 remains open for the unimplemented predictive research and validation work.
