# Android ↔ MCP functional parity matrix

Audited November 1, 2026. Sources:
- Android app 0.7.0-beta.1 (`MainActivity.kt` screens).
- MCP server on `main`, plus the `mcp-parity` change (`cloudflare/src/mcp.mjs` and its modules).
- Production `whoop-lens` Worker settings: 40 bindings, read through the Cloudflare API.
- Production D1 schema and `d1_migrations`.

One MCP endpoint serves every client: `https://whooplens.tech/mcp`, using OAuth through `auth.whooplens.tech`. ChatGPT, Claude and any other MCP client get the same server-side catalog. Owner-only tools are filtered per verified identity (see `AUTHORIZATION.md`).

**Column key**
- **Src:** in source on `main` after this change.
- **Reg:** registered and discoverable when its flag is on.
- **Prod:** enabled in production after this release. Its flag is on, and its tables exist.
- **Member:** an ordinary authenticated member can use it.
- **HW:** needs physical Android hardware.

## Member features

| Android feature / backend capability | MCP tool or workflow | Src | Reg | Prod | Member | Authorization, consent, dependencies | Outstanding | HW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Home dashboard (recovery, strain, sleep, HRV, RHR, steps) | **`get_dashboard_overview`** (new) | ✅ | ✅ | ✅ | ✅ | Verified identity; active membership; WHOOP connection for WHOOP sections; Health Connect section only from records the member's phone already uploaded | — | No |
| Recovery and recovery history | `get_recovery` (paging, `summary`) | ✅ | ✅ | ✅ | ✅ | WHOOP connection; per-member request budget | — | No |
| Sleep, stages, trends | `get_sleep` | ✅ | ✅ | ✅ | ✅ | WHOOP connection | — | No |
| Strain, cycles | `get_cycles` | ✅ | ✅ | ✅ | ✅ | WHOOP connection | — | No |
| Workouts / activity | `get_workouts` | ✅ | ✅ | ✅ | ✅ | WHOOP connection | — | No |
| Body measurements, profile | `get_body_measurements`, `get_profile` | ✅ | ✅ | ✅ | ✅ | WHOOP connection | — | No |
| Summaries, trends, weekly averages | `summary` argument on WHOOP reads, `get_weekly_digest`, `get_ai_usage` | ✅ | ✅ | ✅ | ✅ | `AI_SUMMARY_ENABLED`, `WEEKLY_DIGEST_ENABLED` (on); per-member AI quota | — | No |
| Stress estimate (experimental) | `summary` on WHOOP reads | ✅ | ✅ | ✅ | ✅ | `STRESS_ESTIMATE_ENABLED` + AI summaries (on) | — | No |
| Health Connect records stored on the server | `get_health_connect` | ✅ | ✅ | ✅ | ✅ | Caller's records only | — | No |
| Health Connect file import | `import_health_connect_file` | ✅ | ✅ | ✅ | ✅ | Explicit consent constant; `WEB_HEALTH_IMPORT_ENABLED` (on) | — | No |
| Health Connect phone ingest token | `issue_…`, `revoke_health_connect_ingest_token` | ✅ | ✅ | ✅ | ✅ | Consent / confirmation constants; `HEALTH_CONNECT_WEBHOOK_ENABLED` (on) | — | No |
| Companion sync status | `get_companion_sync_status` | ✅ | ✅ | ✅ | ✅ | `WEB_HEALTH_IMPORT_ENABLED`; tables 0022–0025 (applied) | — | No |
| Pause companion sync (keep records) | `pause_companion_sync` | ✅ | ✅ | ✅ | ✅ | Exact confirmation; consent withdrawn, tokens revoked, fence advanced | — | No |
| Withdraw and delete cloud Health Connect copy | `withdraw_health_connect_import` | ✅ | ✅ | ✅ | ✅ | Exact confirmation; caller's records only | — | No |
| Upload phone Health Connect data (sync now, categories) | Phone app only | — | — | — | — | Needs Android Health Connect API and permissions | Excluded (see below) | **Yes** |
| Life Schedule preference | `set_life_schedule`; read via `get_life_schedule_insights` / `get_account_data_summary` | ✅ | ✅ | ✅ | ✅ | Explicit member request + confirmation; `LIFE_SCHEDULE_ENABLED` (on); table 0024 (applied) | Website editing: #128 | No |
| Life Schedule insights | `get_life_schedule_insights` | ✅ | ✅ | ✅ | ✅ | WHOOP connection | — | No |
| Account & data options (what is stored, how to remove it) | **`get_account_data_summary`** (new) | ✅ | ✅ | ✅ | ✅ | Counts and states only, caller only | — | No |
| Self-service deletion / revocation | `disconnect_whoop`, `withdraw_health_connect_import`, `revoke_…_token`, `pause_companion_sync`, `withdraw_flare_journal`, `delete_flare_entry`, `disconnect_notion`, **`delete_my_samsung_health_records`**, **`delete_my_issue_reports`** (#138) | ✅ | ✅ | ✅ | ✅ | Each has its own exact confirmation or explicit action. Issue reports submitted today (UTC) are kept until the next day so the daily limit cannot be reset | Medical context has no MCP deletion by owner policy (reviewed data): privacy request page | No |
| Consent management | `set_flare_consent`, `pause_flare_analysis`, consent constants on HC tools, `pause_companion_sync` | ✅ | ✅ | ✅ | ✅ | Per-member consent rows | — | No |
| WHOOP connect / disconnect | `connect_whoop`, `disconnect_whoop` | ✅ | ✅ | ✅ | ✅ | Browser binding on (`WHOOP_CONNECT_BROWSER_BINDING`) | — | No |
| Sources & freshness | Source labels and dates on every read; `get_capabilities` | ✅ | ✅ | ✅ | ✅ | — | — | No |
| Capability and account status | `get_capabilities` | ✅ | ✅ | ✅ | ✅ | Caller-filtered tool permissions | — | No |
| Samsung Health records, medical context | `get_samsung_health`, `get_medical_context` | ✅ | ✅ | ✅ | ✅ | Caller only; medical context only when the member asks | — | No |
| Flare journal (MCP-only feature) | `set_flare_consent` … `analyze_flare_patterns` (8 tools) | ✅ | ✅ | ✅ | ✅ | Storage and analysis consent; `FLARE_JOURNAL_ENABLED` (on) | — | No |
| Notion daily log (MCP-only feature) | 9 Notion tools | ✅ | ✅ | ✅ | ✅ | Per-member Notion OAuth; `NOTION_ENABLED` (on) | — | No |
| Issue and error reports | `report_issue`, `report_error` | ✅ | ✅ | ✅ | ✅ | Member preview + approval; `ISSUE_REPORTS_ENABLED` (on) | — | No |
| Service notices | `list_service_announcements` | ✅ | ✅ | ✅ | ✅ | `ANNOUNCEMENTS_ENABLED` on; migration `0020` applied Nov 1, 2026 (#136) | — | No |

## Android-only (intentionally excluded)

These need the phone's operating system or hardware. MCP does not simulate them.

| Android feature | Why |
| --- | --- |
| Direct BLE scan, connect, live and background sessions | Bluetooth radio, Android permissions and foreground service on the phone |
| Home-screen and status widgets, lock-screen behaviour | Android launcher and keyguard |
| Health Connect reading, permissions, upload and sync categories | Android Health Connect API and per-app permissions. MCP reads only what the phone already uploaded with consent; it never bypasses Health Connect permissions |
| Appearance (Glass / Reduced transparency / Battery saver), Arrange Home | Rendering of the app's own screens |
| Background refresh schedule, local caches | Phone background work and on-device storage |
| Sign-in / sign-out of the phone's own session | Per-client OAuth session. MCP clients have their own grant |
| Open-source licenses | Licenses of the APK's bundled code |

## Owner-only (never member-facing)

`review_issue_reports`, `update_issue_report`, `get_reportable_links`, `create_service_announcement`, `update_service_announcement`, `manage_service_announcements`. `get_ai_usage` is a member tool, and only the owner's call also includes global usage. See `AUTHORIZATION.md`.

## Counts (all features on)

- Registered tools: **52** = 46 member + 6 owner-only.
- Production flags (all on since #136): owner **52**, member **46**.
- History: 46/43 at release R-MCP; 50/44 after announcements (#136); 52/46 with self-service deletion (#138).
