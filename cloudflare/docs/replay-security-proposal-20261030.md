# Replay security proposal — review required

Baseline: f24f86b1e58e00b5910143de3e23a0fc7380034f. Provider stays pinned at @cloudflare/workers-oauth-provider 1.2.3.

The local reproducers establish three boundary failures: a delayed refresh can restore a revoked grant or reopen spent-token recovery; upstream callback KV get/delete is not atomic; and a pending Health Connect file import/token issuance can outlive withdrawal or membership removal. Intentional previous-refresh-token recovery is preserved.

## Proposed changes

- Migration 0021 adds a primary-D1 OAuth state table. Request-scoped adapters use revision-conditional writes, one-time transaction consumption, retained revocation tombstones, and live-grant checks on token reads/publication.
- Auth fetch and validation RPC use that adapter only when OAUTH_STATE_STORE=d1. Missing D1 state never falls back to KV. Existing configuration is unchanged.
- GET/HEAD/OPTIONS marked Early-Data: 1 receive 425 before auth/resource bindings are accessed. This is an application guard; manually supplying the header does not prove TLS 0-RTT.
- Migration 0022 adds per-member Health Connect withdrawal/revocation generation nonces. File import and ingest-token issuance bind to the admitted generation and active membership in each write. Withdrawal/revocation advances the generation atomically. HTTP import snapshots admission before body transfer; a later deliberate import can regrant consent.

- Migration 0023 advances the Health Connect fence and permanently revokes phone tokens on membership deactivation or deletion, so an old admitted request cannot regain authorization after reactivation. The former-member runbook covers health fences and both OAuth stores; full D1 deletion retains revision-advancing revocation tombstones.

## Approval and cutover gates

This branch has not deployed anything. Do not enable d1, apply migrations remotely, or merge as an automatic production cutover.

1. Approve and stage migrations 0021, 0022 and 0023. Migration 0022 supplies the required Health Connect schema; migration 0023 supplies the membership removal/reactivation barrier. Do not release without both protections.
2. Choose a deliberate OAuth reconnect cutover or a separately designed offline migration of existing registrations/grants. Empty D1 does not import KV; switching it on will invalidate existing KV-only credentials and registrations. Do not silently copy/fall back to KV.
3. Cut over all authorization traffic and token-validation RPC consistently; prevent old versions from continuing to issue or validate KV credentials. Mixed modes do not provide revocation guarantees.
4. Keep revoked grant tombstones. Define bounded retention for expired non-grant state before large-scale use; never remove tombstones while stale writers can exist.
5. Evaluate Free-plan D1 row/query/storage limits for actual volume. The proposal requires no paid product or plan upgrade, but does not certify production capacity.
6. Separately approve disabling Cloudflare 0-RTT as an interim GET replay reduction. It does not fix POST refresh races. Keep TLS 1.3 enabled.

Rollback of a future D1 cutover must not re-enable old KV credentials: they can include credentials revoked in the new store. Use an approved fail-closed/reconnect plan.

## Reproduction and tests

From cloudflare/ after npm ci --ignore-scripts:

- node --test test/provider/replay-workerd.test.mjs runs both baseline exposure demonstrations (KV mode) and proposed-fix regressions (D1 mode) in two independent local Worker isolates.
- node --test test/provider/replay-closure.test.mjs runs detailed D1 replay invariants by default. REPLAY_STORE=kv deliberately reproduces remaining KV failures.
- node --test test/provider/health-replay-d1.test.mjs runs synthetic ingestion, file-import, token-issuance, membership, withdrawal and revocation commit-boundary races.
- node --test test/provider/oauth-state-store.test.mjs test/provider/early-data-routes.test.mjs checks storage compatibility and 102 early-data route/method combinations.
- Existing offline suites and issuer/resource Wrangler dry-run builds remain required.

The local pinned workerd binary supports compatibility date 2026-07-29. Local runtime fixtures use that date; production Wrangler dates remain unchanged. Runtime tests use synthetic upstream identity, while the Node integration suite separately verifies real signed synthetic Access claims for two active members and one inactive member. Production multi-region KV timing and authenticated TLS replay are not claimed verified.
