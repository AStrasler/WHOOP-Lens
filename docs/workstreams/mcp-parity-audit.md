# MCP-first parity audit (#121)

Audited November 1, 2026 against the Android app as shipped in `0.6.0-beta.5` (PR #112 head; screens in `MainActivity.kt`) and the MCP tools on `main` plus this PR. Status values:

- **MCP**: available to a member who uses only MCP.
- **Web**: available on the WHOOP Lens website.
- **Phone**: physically requires the phone (Health Connect API, Bluetooth, launcher, Android UI).
- **Gap**: does not physically need the phone, but is not reachable without the app.

| App feature (screen / section) | Status | MCP route or reason |
| --- | --- | --- |
| Home overview, Recovery, Strain, Sleep, Activity, Vitals, metric detail charts, two-week history, weekly averages | **MCP** | `get_recovery`, `get_sleep`, `get_cycles`, `get_workouts`, `get_body_measurements`, `get_profile` (with `summary` and `chart_data` when enabled), `get_weekly_digest` |
| Sources & freshness | **MCP** | Every MCP read carries its source label and dates; `get_capabilities` reports connection and record status |
| **Life Schedule** (Preferences) | **MCP** (this PR) | `get_life_schedule_insights` reads; new `set_life_schedule` writes only on an explicit member request. Previously app-only |
| Service notices | **MCP** | `list_service_announcements` (when announcements are enabled) |
| WHOOP connect / disconnect | **MCP** | `connect_whoop`, `disconnect_whoop` |
| Health Connect records stored on the server | **MCP** | `get_health_connect`, `import_health_connect_file`, `withdraw_health_connect_import` |
| Health Connect phone ingest token | **MCP** | `issue_health_connect_ingest_token`, `revoke_health_connect_ingest_token` |
| Reading Health Connect on the device (15 permissions) | **Phone** | Android Health Connect API exists only on the phone |
| Cloud synchronization: upload consent, data categories, sync now, pause | **Phone** (upload); **MCP** (status, pause) | Uploading phone data is phone-side by nature. The two server-side controls are now MCP tools: `get_companion_sync_status` (read-only: paused, consent, stored count, last sync, categories; same data as `GET /v1/health-connect/sync-status`) and `pause_companion_sync` (exact confirmation; wraps `pauseCompanionSync()`: withdraws consent, revokes ingest tokens, advances the health fence, keeps records). Pause differs from `revoke_health_connect_ingest_token` (consent stays granted) and `withdraw_health_connect_import` (records deleted). Resuming is the member's next manual sync from the phone app |
| Direct BLE (experimental standard heart rate) | **Phone** | Bluetooth on the phone (#100) |
| Widgets & privacy, At a glance, lock-screen level | **Phone** | Launcher/lock-screen surfaces (#102) |
| Appearance (Glass / Reduced transparency / Battery saver) | **Phone** | Android rendering only; nothing to sync |
| Arrange Home (card order and visibility) | **Phone** | Layout of the app's own Home screen |
| Refresh & sync schedule (background refresh) | **Phone** | Phone background work |
| Sign in / sign out, revoke this phone's grant | **Phone** | Per-client session. MCP clients have their own OAuth connection, which the member revokes in that client |
| Flare journal | **MCP** (MCP-only feature) | `set_flare_consent` … `analyze_flare_patterns` |
| Issue and error reports | **MCP** | `report_issue`, `report_error` |
| Open-source licenses & credits | **Phone** | Licenses for the APK's bundled components; not a member data feature |

## Findings

Parity is not complete: the website settings requirement (Finding 3) is still open.


1. **Closed by this PR:** Life Schedule was the only member *setting* reachable only from the app. `set_life_schedule` closes it, and `get_capabilities` now advertises the feature (it previously did not mention Life Schedule at all, so MCP-only members could not discover it).
2. **Closed by this PR:** companion sync status and the non-destructive pause were member-visible server controls with no MCP tool. `get_companion_sync_status` and `pause_companion_sync` close them. Status is listed with `WEB_HEALTH_IMPORT_ENABLED`; pause is listed when either Health Connect path is on, the same rule as withdrawal, so a member can always stop uploads. Both are caller-scoped, check active membership and the lifecycle schema, and fail with safe messages that say nothing changed. Uploading phone data stays phone-side.
3. **Website settings — blocked by this workstream's own constraint.** The website has no member sign-in today: the legacy Supabase web sign-in was retired, and members authenticate only through MCP clients and the Android app (Cloudflare Access + OAuth). A web Life Schedule editor needs a new browser OAuth client for `auth.whooplens.tech` (public client with PKCE, consent, token storage in the browser). That is an auth-surface change, which #121 excludes ("No change to auth"). **Owner decision required:** approve a separate, reviewed web sign-in workstream, or drop web parity in favor of MCP plus the app.

Nothing above changes Android permissions, adds services, or touches the OAuth cutover / migration 0021.
