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

- PR #34 is already merged. Its requested stress/source/claim/cache corrections are covered by retained regression cases and the new bounded production selection contract. All 32 outstanding review threads were resolved after the 318-test suite and CI passed.
- PR #21 is a closed, unmerged legacy Supabase parity proposal with merge conflicts. Source inspection finds the same pre-write revocation gap and independent chunk writes in its proposed webhook/RPC path. It is not an approved production-ready replacement for the current Cloudflare integration and must not be merged or marked complete by this audit. Its proposed SQL is not applied.
- Issue #23 includes research/user-evaluation criteria, experimental validity, provider retention assessment and a distinct three-person rollout proposal beyond functional delivery. Code activation alone does not establish those criteria. Historical note: #23 has since been closed and superseded by #53, a future autoimmune/flare proposal. This audit does not implement or validate that proposal.
- Issue #25's future aggregation and improvement wishlist, and #53's flare concept, remain out of scope and unchanged.
- The stress index is an experimental formula, not a validated stress measurement. No intraday WHOOP Stress Monitor API or zone durations are inferred.
- Legacy unversioned phone records cannot establish freshness ordering across distinct retries; stable keys provide idempotence, not an invented modification timestamp.
- Synthetic tests establish application boundaries, not proof about every third-party service or phone background scheduler. No destructive revocation or ingest-token rotation is performed on a real account for testing.
- Release/version, live flags and operational verification are recorded after deployment below.

## Deployment record

- Repair commit: `d5b0425c1d3f368d5e8f33df5fa1bba4e823f02c`; PR #35 merged as `a3d2c88b515a198896ba1641a72c04e01ee4069a`.
- Deployed 2026-10-15 05:56:56 UTC, resource Worker `whoop-lens`, version `53e335c6-5a36-4b8c-8b19-9d97369affbe`, 100% traffic. MCP source version 1.1.0. Auth Worker unchanged.
- Local verification: 318 tests passed, zero failures/skips; both OAuth bundles built. GitHub Check integration (#462), Cloudflare staging isolation (#288), and Cloudflare OAuth build validation (#83) all succeeded.
- Read back production settings: AI_SUMMARY_ENABLED, STRESS_ESTIMATE_ENABLED, WEEKLY_DIGEST_ENABLED, WHOOP_OAUTH_ENABLED, WHOOP_READS_ENABLED, HEALTH_CONNECT_WEBHOOK_ENABLED, WEB_HEALTH_IMPORT_ENABLED, MCP_ENABLED and OAUTH_RESOURCE_ENABLED are true. Existing router gate MIGRATION_API_ENABLED remains true; no diagnostic/migration operation was enabled or run.
- Existing binding names/types, D1 database, auth service, model, secret bindings and Secrets Store references preserved through strict binding inheritance. No secret values were retrieved or replaced. Query-string log redaction is now true; workers.dev and previews remain disabled.
- Live non-destructive checks: signed-in WHOOP recovery returned records and a successful model summary; text carries the WHOOP Lens experimental label, index units, date, band, confidence and explicit Stress Monitor disclaimer. Signed-in Health Connect reads and capability discovery succeeded. No health values are included in this report. Anonymous MCP tools/list and a synthetic invalid webhook token each returned HTTP 401.
- Live digest execution remains unverified: the connected chat tool catalog does not expose get_weekly_digest after server activation. No credentials were extracted or authentication bypassed to work around that catalog limitation. Synthetic generation/cache/isolation/retry tests pass and the production flag is verified.
- No real-account revocation, token rotation, ingestion writes, migration, membership edit or destructive data check was performed. Phone background delivery is covered at the endpoint contract level, not an on-device scheduler test.

The tested implementation satisfies the scoped account-isolation, consent, integrity and grounded-output requirements. Operational evidence confirms private production access, existing WHOOP authorization and Health Connect reads; the live digest and phone-delivery limitations above prevent an unconditional end-to-end certification.

## Current-state follow-up, 2026-10-15

Two additional medium-severity digest defects were reproduced with synthetic data: an explicit window ending today was persisted before its last day ended, and malformed ready-cache bodies blocked regeneration indefinitely. Open windows now bypass cache reads and writes while preserving the existing query contract. Invalid ready entries are replaced with a unique pending lease only if the exact inspected body still matches. Concurrent repairs and other accounts remain untouched. Cache namespace v4 prevents replay of earlier premature snapshots; no data migration or deletion is required. Regression tests cover updated records during an open window, reuse after closure, invalid-cache recovery, account isolation and competing pending/ready replacements.

The current chat still exposes no weekly-digest call, and plugin discovery found no alternate connection. This limits live authenticated execution, not production feature activation. HC Webhook is the deployed phone integration; the repository's optional Android manual-preview app remains unreleased and disabled. No background-scheduler conclusion follows from successful stored-record reads.
