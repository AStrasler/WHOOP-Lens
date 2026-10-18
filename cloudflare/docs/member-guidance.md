# Shared member guidance

Every seat on this server gets the same guidance. Nothing here grants a permission or adds a data path.

| Area | Where it lives | What a member sees |
|---|---|---|
| Feature states | `src/member-guidance.mjs` `featureStates`, returned as `get_capabilities.server_features` | Each feature is `enabled`, `disabled` (flag not exactly `"true"`) or `not_configured` (flag on, required setting or binding missing; AI summaries also need the account analytics budget settings, or they fall back to a template). The WHOOP connection state runs the same settings check as `connect_whoop`; only presence is checked, never a secret value. A listed tool whose flag is off returns "This feature (...) is turned off on this WHOOP Lens server. Nothing was changed." instead of the generic WHOOP error. |
| Token versus data | `issueIngestToken` (`this_call_delivered_data:false`, `next_step`, `verify_with`, `note`) and `get_capabilities.account.health_connect` | Token state (`none`/`active`/`revoked`), when it was issued, the latest authenticated delivery window, this account's record count and latest stored time. An accepted delivery can store zero records. |
| Role boundaries | `ROLE_BOUNDARIES`, returned as `get_capabilities.account.seat_role` and `role_boundaries` | The owner is recognized by the same `WHOOP_LENS_DEVELOPER_USER_ID` rule as `get_ai_usage`, even after disconnecting WHOOP. Every seat, the owner included, reads and changes only its own data. The developer seat also sees a server-wide AI total with no per-member breakdown. No MCP tool approves members or changes seats or roles. |
| Evidence | `memberGuidance` in `src/host-instructions.mjs`, plus `as_of`, `evidence` and `not_verifiable_here` fields | The host is told to cite the tool and field behind each claim and to label anything else unverified. |

Status reads are for the signed-in account only: counts and timestamps, never record content, token values or digests, or other members. If a status read fails, `get_capabilities` still answers and reports Health Connect status as `unknown`.

Synthetic scenarios (owner, a member whose phone data arrives, a member whose token is issued but whose delivery stores nothing) are in `test/member-guidance.test.mjs`.
