# Private MCP and Health Connect audit, 2026-10-15

Scope: existing private Cloudflare MCP, OAuth/WHOOP authorization, AI summaries, stress calculations, weekly digests and Android HC Webhook ingestion. Synthetic two-user tests only. The existing Android manual-export app and legacy Supabase integration were inspected for compatibility; no new companion, public access or cross-account analytics was added.

The owner authorized merge, private production deployment and supported feature activation after verification. No credentials, memberships, health rows or WHOOP connections are replaced by this release. No database migration is required. Production schema inspection verified the existing digest, consent, ingest and usage tables. Formal Codex Security scan tooling could not run because its referenced support resources were unavailable; this is a direct source/test audit, not a formal scanner attestation.

## Verified findings and repairs

| Severity | Failure / root cause | Correction and evidence |
| --- | --- | --- |
| High | An upload authorized before body consumption could write after token revocation, rotation, withdrawal or membership removal. | Repeat token/consent/membership predicates inside a single D1 write transaction; delayed-body tests cover all four cases and preserve the second account. |
| High | Model text could attribute an HRV number to recovery because the prose filter accepted any number found in the statistics. | Model returns bounded statement indexes only. Worker constructs all metric/date/unit statements and the mandatory experimental stress label, band and confidence. Free text, extra fields, wrong indexes and injected claims fall back. |
| Medium | Same-payload deduplication retained the last row, even when older; unversioned retries overwrote versioned data. | In-memory and SQL conflict policies both retain the newest known modification. Legacy unversioned updates remain supported. |
| Medium | Separately committed webhook chunks could leave a partial upload on failure. | Single transactional batch. A synthetic late failure rolls back all 1,800 rows; retry succeeds without duplicates. |
| Medium | Malformed history pages appeared complete; failed ordinary baseline retrieval could be persistently cached. | Strict page/cursor checks and explicit baseline completeness. Incomplete data is returned honestly and never persisted as a ready digest. |
| Medium | An expired digest generator could overwrite or delete its replacement's claim. | Unique claim lease checked on save and release; interleaved old/new-owner tests. |
| Medium | Cached digests survived local WHOOP disconnect and reauthorization. | Disconnect and callback transactions invalidate only the user's cache/claims. MCP digest reads require an existing connection and recheck membership and connection afterward. |
| Medium | WHOOP callback could save credentials after membership changed during token exchange. | Active-membership predicate at the final credential write. |
| Medium | MCP and file import buffered entire untrusted request bodies before checking size. | Shared streaming byte limit, including unknown Content-Length and invalid UTF-8 tests. |
| Medium | JavaScript date parsing silently normalized impossible calendar dates. | Validate ISO timestamp and calendar date before normalization. |
| Low | Equal first/last values were described as a stable series even when intermediate values differed. | Describe first and latest values without claiming stability. |
| Low | Live invocation logging did not redact callback query strings. | Production API deployment enables query-string redaction (the pinned Wrangler schema does not expose this API setting), preserving other logging settings. No historical-log inspection or secret output. |

## Verification and compatibility

Existing OAuth provider, Access JWT, MCP versions, refresh rotation, encryption, membership, consent, two-user record reads, quota and stress calculation suites are retained. New tests use in-memory SQLite and synthetic model/API responses; no real health records are fixtures. Raw read results, paging arguments, consent strings and webhook response fields remain compatible. AI output preserves the summary envelope, charts, fallback reasons and usage accounting. Only model output parsing is stricter; it selects factual statements rather than supplying prose.

Checked-in feature flags remain off to prevent accidental activation. The production release preserves existing bindings and secrets and enables the completed AI, stress, digest, WHOOP, web-file and phone-webhook paths. Public workers.dev and preview routes must remain disabled. The historical `MIGRATION_API_ENABLED` variable is the existing router gate, not permission to run migration scripts. No diagnostic or token-migration feature is newly enabled.

## Open work and limits

- PR #34 is already merged. Its requested stress/source/claim/cache corrections are covered by retained regression cases and the new bounded production selection contract. Resolve review threads only after these checks pass.
- PR #21 is an unmerged legacy Supabase parity proposal with merge conflicts. Source inspection finds the same pre-write revocation gap and independent chunk writes in its proposed webhook/RPC path. It is not an approved production-ready replacement for the current Cloudflare integration and must not be merged or marked complete by this audit. Its proposed SQL is not applied.
- Issue #23 includes research/user-evaluation criteria, experimental validity, provider retention assessment and a distinct three-person rollout proposal beyond functional delivery. Code activation alone does not establish those criteria. Keep the research issue open and record the implemented scope.
- Issue #25's future aggregation/autoimmune concepts remain out of scope and unchanged.
- The stress index is an experimental formula, not a validated stress measurement. No intraday WHOOP Stress Monitor API or zone durations are inferred.
- Legacy unversioned phone records cannot establish freshness ordering across distinct retries; stable keys provide idempotence, not an invented modification timestamp.
- Synthetic tests establish application boundaries, not proof about every third-party service or phone background scheduler. No destructive revocation or ingest-token rotation is performed on a real account for testing.
- Release/version, live flags and operational verification are recorded after deployment below.

## Deployment record

Pending completion of final CI, merge and production verification.
