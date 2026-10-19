# Shared member guidance

Every seat on this server gets the same guidance. Nothing here grants a permission or adds a data path.

| Area | Where it lives | What a member sees |
|---|---|---|
| Feature states | `src/member-guidance.mjs` `featureStates`, returned as `get_capabilities.server_features` | Each feature is `enabled`, `disabled` (flag not exactly `"true"`) or `not_configured` (flag on, required setting or binding missing; AI summaries also need the account analytics budget settings and a supported model, or they fall back to a template). The WHOOP connection state runs the same settings check as `connect_whoop`; only presence is checked, never a secret value. A listed tool whose flag is off returns "This feature (...) is turned off on this WHOOP Lens server. Nothing was changed." instead of the generic WHOOP error. |
| Token versus data | `issueIngestToken` (`this_call_delivered_data:false`, `next_step`, `verify_with`, `note`) and `get_capabilities.account.health_connect` | Token state (`none`/`active`/`revoked`), when it was issued, the latest authenticated delivery window, this account's record count and latest stored time. An accepted delivery can store zero records. |
| Role boundaries | `ROLE_BOUNDARIES`, returned as `get_capabilities.account.seat_role` and `role_boundaries` | The owner is recognized by the same `WHOOP_LENS_DEVELOPER_USER_ID` rule as `get_ai_usage`, even after disconnecting WHOOP. Every seat, the owner included, reads and changes only its own data. While `get_ai_usage` is listed (AI summaries on) and the owner setting names the account, it also sees a server-wide AI total with no per-member breakdown. No MCP tool approves members or changes seats or roles. |
| Evidence | `memberGuidance` in `src/host-instructions.mjs`, plus `as_of`, `evidence` and `not_verifiable_here` fields | The host is told to cite the tool and field behind each claim and to label anything else unverified. |

Status reads are for the signed-in account only: counts and timestamps, never record content, token values or digests, or other members. If a status read fails, `get_capabilities` still answers and reports Health Connect status as `unknown`.

Synthetic scenarios (owner, a member whose phone data arrives, a member whose token is issued but whose delivery stores nothing) are in `test/member-guidance.test.mjs`.

## Source hierarchy (client-facing contract)
Every client of the Cloudflare MCP server (`whoop-lens`) gets the same eight rules, with no custom instructions of its own: `SOURCE_HIERARCHY` in `src/member-guidance.mjs`. They come first in every `initialize` `instructions` variant, so a host that truncates instructions keeps them. `get_capabilities` also returns them as `source_hierarchy`, and short versions appear in the `serverInfo.description` and in tool descriptions.

**Enforced by the server, in its own responses**
- WHOOP read results (`get_profile`, `get_body_measurements`, `get_recovery`, `get_sleep`, `get_workouts`, `get_cycles`) carry `source: "whoop"` and `source_authority: "authoritative"`, in both the content text and `structuredContent`.
- WHOOP history pages carry `whoop_measurements`: `records_returned`, `missing` (no records), `latest_record_at`, and, on a first page of recovery, sleep or cycles, `stale` (no record or the newest is over 36 hours old). Workouts are irregular, so they get no `stale` judgement.
- Health Connect and Samsung Health results carry their own `source` and `source_authority: "supplementary"`. Medical context carries `source_authority: "user_directed"`.
- The server never fills a missing or failed WHOOP result with another source. Each tool returns only its own source.

**User-entered WHOOP records**
- Rules 7 and 8 make user-entered records (sleep, naps or activities the person entered manually, journal entries, symptoms). WHOOP does not mark which records were entered manually, and `nap` says a sleep was a nap, not who entered it authoritative records of what the person reported. Sensor data establishes what WHOOP measured, manual entries what the person recorded, and user context what they report experiencing.
- The WHOOP v2 API (developer.whoop.com/api, checked 2026-10-19) has no field marking a sleep, workout, cycle or recovery as user-entered or sensor-generated. `nap` is the only related field. So `whoop_measurements.entry_origin` is `"unknown"`, with a note, instead of a guessed per-record value. `get_sleep` also reports `naps_returned`. Flare journal entries are labeled `source: "user_reported"`.
- WHOOP records pass through unmodified: same values, order and fields. No tool drops, merges or deduplicates them, or prefers sensor records. Two derived features compute over a subset, but the raw records in the same result are untouched. The opt-in AI summary limits stats to dated records in its window and pairs sleep with recovery by WHOOP id. The experimental stress estimate (flag-gated) skips naps and unscored sleeps and ignores repeated ids when computing its index.

**External sources (for example ChatGPT Health)**: WHOOP Lens instructions never tell a client to look up external Health records automatically. For broad requests the AI offers them, and it consults them only when the user asks. These are WHOOP Lens's own instructions. The AI host platform may have independent requirements of its own, which WHOOP Lens cannot override; the instructions say so.

**Depends on the consuming AI's compliance**
- Calling the WHOOP tools at all, citing sources, separating facts from hypotheses, disclosing missing or stale data, and not adding external sources or medical records unless the user directs it.
- MCP metadata cannot force an external AI to call a tool or obey instructions. Hosts may truncate, summarize or ignore `instructions` and `serverInfo`, and the model may ignore tool descriptions or result fields. The server can only label what it returns and keep sources apart.
