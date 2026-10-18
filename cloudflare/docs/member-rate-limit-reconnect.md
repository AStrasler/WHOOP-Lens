# Per-member WHOOP request limit and reconnect cursor invalidation

Branch `cursor/member-rate-limit-reconnect`, stacked on `cursor/post-deploy-audit-fixes`
(it builds on that branch's disconnect-based cursor rejection, `whoop_credential_revocations.revoked_at`,
and its WHOOP 429 reporting). Not applied to production D1 and not deployed.

## 1. Per-member WHOOP request limit (migration 0015)

WHOOP limits the whole app to 100 requests a minute and 10,000 a day. Every outbound WHOOP API
request (`callWhoop`) now first reserves one unit for the authenticated member, after membership and
the connection are verified and immediately before the request. Over budget, nothing is sent to WHOOP.

| Setting (Worker var, optional) | Default | Notes |
| --- | --- | --- |
| `WHOOP_MEMBER_LIMIT_ENABLED` | on | `"false"` turns enforcement off |
| `WHOOP_MEMBER_LIMIT_PER_MINUTE` | 25 | clamped to 1..100 |
| `WHOOP_MEMBER_LIMIT_PER_DAY` | 1000 | clamped to 1..10000 |
| `WHOOP_DEVELOPER_LIMIT_PER_MINUTE` | member value | developer seat only |
| `WHOOP_DEVELOPER_LIMIT_PER_DAY` | member value | developer seat only |

- Fair share: 10 seats (9 public + 1 developer). 1,000/day x 10 = WHOOP's 10,000/day. 25/minute is
  2.5x the strict 10/minute because a summary with baselines uses about 18 requests and an
  `auto_page` call 4; four members at full speed still fit in 100/minute.
- Developer/owner seat (`WHOOP_LENS_DEVELOPER_USER_ID`, the same rule that assigns
  `seat_role='developer'`): **not exempt**, same limit by default, configurable separately.
  Seat roles, seat counts and membership checks are unchanged.
- A missing, zero or malformed value uses the default, so a bad setting cannot lock members out.
- Windows are fixed UTC minute and UTC day. One row per member (`whoop_member_request_budget`),
  updated by a single atomic UPSERT, so parallel requests cannot overspend.
- Token refreshes (WHOOP's OAuth token endpoint) are not counted.
- Over the limit:
  - MCP: tool error "This account reached its WHOOP Lens request limit (N WHOOP requests per
    minute|day (UTC)). No WHOOP request was made. Wait about S seconds..."
  - REST: HTTP 429, `Retry-After: S`, `{"error":...,"rate_limit_scope":"member"}`.
  - `auto_page`: the records already fetched are returned with `complete:false`,
    `incomplete_reason:"rate_limited"`, `rate_limit_scope:"member"` (`"whoop"` when WHOOP itself
    throttled), `retry_after_seconds`, and a cursor that resumes at the next page.
- Without the table (migration not applied yet, or rolled back) enforcement is skipped and logged
  once (`member_rate_limit`/`schema_missing`). Any other D1 error fails closed (no WHOOP request).

## 2. Reconnect cursor invalidation (migration 0016)

`whoop_connection_generations(user_id, generation)` is bumped in the same D1 batch as:
- every OAuth callback that stores credentials, including a reconnect over an existing connection
  without a disconnect (the bump is conditional on the new credential actually being stored; a
  seat-limit abort rolls it back), and
- every disconnect.

History cursors carry the generation read at the start of the call (before any WHOOP request) and
are rejected, with no WHOOP request, once it changes. Cursors sealed before 0016 (no generation) are
generation 0, which is also the value for members without a row, so existing sequences keep working
until that member's next reconnect or disconnect. Without the table only the `revoked_at` check
applies (the behaviour of the audit branch).

## Migration SQL, rollback and compatibility

- Up: `migrations/0015_member_whoop_request_budget.sql`, `migrations/0016_whoop_connection_generations.sql`
  (CREATE TABLE IF NOT EXISTS only; no ALTER, no backfill, no change to existing rows).
- Down: `migration/rollback/0016_...down.sql` then `migration/rollback/0015_...down.sql`
  (DROP TABLE + remove the `d1_migrations` row). Kept outside `migrations/` so wrangler never runs them.
- Old code (main 90a5277 / live 04e4499d) with the new schema: main's full suite plus an
  old-code paging/callback/disconnect scenario pass; old code never touches the new tables.
- New code with the old schema: both features degrade to today's behaviour (tested).
- Tested in `test/member-rate-limit-reconnect.test.mjs`: up after 0001-0014, idempotent re-run,
  down, re-up, existing rows byte-identical.

### Production apply (needs Aaron's approval; not done)

Production `d1_migrations` lists only `0013` and `0014` (0001-0012 were applied by `d1 execute`), so
`wrangler d1 migrations apply` would try to re-run 0001-0012. Apply the two files explicitly:

```
npx wrangler d1 execute whoop-lens-migration --remote --file=migrations/0015_member_whoop_request_budget.sql
npx wrangler d1 execute whoop-lens-migration --remote --file=migrations/0016_whoop_connection_generations.sql
npx wrangler d1 execute whoop-lens-migration --remote --command="INSERT INTO d1_migrations(name) VALUES('0015_member_whoop_request_budget.sql'),('0016_whoop_connection_generations.sql')"
```

Order: schema first (safe with live code), then deploy the code. Rollback: redeploy the previous
version, then (optionally) run the down files.

## Extra D1 work (measured with the synthetic harness)

| Operation | audit branch | this branch | delta |
| --- | --- | --- | --- |
| manual page, first | 3 | 5 | +1 reservation, +1 generation read |
| manual page, with cursor | 4 | 5 | +1 reservation (generation folded into the revocation read) |
| auto_page (4 pages), first | 9 | 14 | +4 reservations, +1 generation read |
| auto_page (4 pages), with cursor | 10 | 14 | +4 reservations |
| OAuth callback | 6 | 8 | +1 schema check, +1 statement inside the existing batch |
| disconnect | 7 | 9 | +1 schema check, +1 statement inside the existing batch |
| over the limit | n/a | +1 | one SELECT to compute Retry-After |

Every reservation is a primary-key UPSERT (a D1 write). Local SQLite: about 38 us per reservation and
9 us for the combined revocation/generation read. Production D1 server-side batch time over the last
7 days: P50 0.27-0.6 ms, P90 0.5-2.6 ms per batch. Worker-to-D1 network round trips are extra and
were not measured (that needs a deployed Worker).
