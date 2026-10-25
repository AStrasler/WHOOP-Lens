# WhoopLens seat cap

Controlled access only: no public registration and no automatic expansion. A seat is a WHOOP
connection (`whoop_connections` row). Every connection counts, including the owner's.

| Setting (resource Worker var) | Default | Meaning |
| --- | --- | --- |
| `WHOOP_LENS_SEAT_LIMIT` | 3 | Maximum WHOOP connections, owner included. Whole number 1-10; values above 10 are clamped to 10 (the database ceiling); a missing or malformed value uses 3, never more. |

How a member gets a seat:
1. They submit the seat request form (auth Worker, `/request-seat`, migration 0014). It only emails the
   owner; it never creates an account or reserves a seat.
2. The owner approves by linking their identity and activating `whoop_members.active` (manual, as today).
3. The member connects WHOOP. `connect_whoop` / `/v1/whoop/connect` refuse with
   "All N WhoopLens seats are in use..." (MCP tool error; REST 409 with `seat_limit`) when the cap is
   reached, before sending the member to WHOOP.
4. The callback writes the connection only if the member already holds one or fewer than N exist.
   The check is inside the same INSERT, so concurrent callbacks cannot overshoot the cap (tested).

A member who already has a connection can always reconnect, also when the cap is lowered below
the current count. Lowering the cap never disconnects anyone; it only stops new connections.
Disconnecting frees a seat. Reads and the per-member request limits are not affected by the cap,
and the request limits (`WHOOP_MEMBER_LIMIT_*`, `WHOOP_DEVELOPER_LIMIT_*`) do not affect it.

Migration 0002's triggers (9 public + 1 developer) and the one-developer index remain as the
database ceiling. No migration is needed for the cap. To admit more than 3 people, the owner
raises `WHOOP_LENS_SEAT_LIMIT` after approving the request.

Live state on Oct 18, 2026 (read-only count): 2 active members, 2 WHOOP connections, both
`seat_role='public'` (no developer seat in use). Under the default of 3, one seat is free.
Tests: `test/seat-limit.test.mjs`.
