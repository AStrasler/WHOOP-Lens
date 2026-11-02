# MCP authorization: members and the owner

## Identity
- **Router:** `/mcp` accepts a request only after the OAuth resource layer verifies the bearer token (`verifyIdentity`). It then checks `whoop_members.active`. No token, an invalid or revoked token → 401. Inactive member → 403. Nothing runs before these checks.
- **Verified user ID:** every tool receives this one ID from the router. No tool argument names a user. Arguments are validated against exact key sets, so a `user_id`, `role`, `owner` or similar field makes the call invalid instead of redirecting it.
- **Owner:** exactly `WHOOP_LENS_DEVELOPER_USER_ID`, a server binding compared with the verified ID (`src/roles.mjs`, `isVerifiedOwner`). The comparison is exact and case-sensitive. Headers, emails, names, client claims and arguments play no part. If the binding is unset, nobody is the owner.

## Owner-only tools
`review_issue_reports`, `update_issue_report`, `get_reportable_links`, `create_service_announcement`, `update_service_announcement`, `manage_service_announcements`.

Three layers enforce this on every call:
1. **Discovery:** feature modules list these tools only for the owner, and `memberSafeCatalog` removes any owner tool from a non-owner's `tools/list` as the final step. `get_capabilities` derives its tool permissions from the same filtered list.
2. **Central call guard:** in `handleMcpRpc`, a non-owner calling an owner tool gets `-32602 Unknown tool`, the same reply as a tool that does not exist, and an `owner_tool_denied` diagnostic. Validation and execution never run.
3. **Module guards:** `reviewIssueReports`, `updateIssueReport`, `runErrorReportTool` and the announcement owner functions re-check the owner themselves.

`get_ai_usage` is a member tool. Only for the owner does the reply also include global usage.

## Member boundary
- Every member gets the same catalog, subject to the same feature flags.
- **Isolation:** reads and writes bind the verified ID in SQL. Writes also re-check active membership inside the statement where a race matters (Life Schedule, Health Connect fences).
- **Consent:**
  - Health Connect storage needs its consent constant.
  - The flare journal needs storage and analysis consent.
  - Pausing companion sync withdraws consent and revokes tokens.
  - Withdrawal deletes only the caller's records.
- **Confirmation:** destructive and consent-changing tools require an exact confirmation value. Without it the arguments are invalid and nothing changes.
- **Missing data:** reported as missing, stale or unavailable. Never filled from another source or shown as zero.

## Tests
`cloudflare/test/member-owner-boundary.test.mjs` runs everything through the real `/mcp` route with synthetic members:
- owner versus member discovery;
- direct owner-tool calls by members;
- forged headers, arguments and look-alike IDs;
- `get_capabilities` permissions;
- missing, invalid, revoked and reauthenticated sessions, and inactive members;
- cross-member isolation;
- dashboard source labelling and missing data;
- feature flags;
- destructive confirmations.

A mutation check (forcing `isVerifiedOwner` to true) makes the suite fail. Related suites: `life-schedule`, `companion-sync`, `service-announcements`, `error-reports`, `member-diagnostics`, `mcp`.

## Connecting and refreshing clients
There is one endpoint, `https://whooplens.tech/mcp`, and the catalog is computed per request. `tools/list` is marked `cacheScope: private` with a 5-minute TTL. Clients cache tool lists, so after a release:
- **ChatGPT:** Settings → Connectors (Apps) → WhoopLens → Refresh. Or start a new chat after a few minutes. If tools are still missing, disconnect and reconnect, which signs in again.
- **Claude:** Settings → Connectors → WhoopLens → reconnect, or start a new conversation. Claude Code sessions can refresh the MCP tool list.
- **Other MCP clients:** re-run `tools/list`, or reconnect.

Reconnecting never changes a member's role or data. It only refreshes the catalog and, when needed, the OAuth grant.
