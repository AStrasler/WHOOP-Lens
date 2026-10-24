# Structured MCP error reporting release — October 23, 2026

## Delivered

`get_reportable_links` and `report_error` are deployed under the existing
`ISSUE_REPORTS_ENABLED=true` flag. The existing free-text reporter and owner
review/status tools remain available. Structured reports use the same queue,
approval mechanism, limits, retention and confirmed references.

An eligible link is the authenticated active member's stored WHOOP connection
and current connection generation. Link handles contain no member ID and do
not authorize anything on their own. Ownership and eligibility are checked
before preview and submission, then membership, connection presence and
generation are checked again inside the submission INSERT. No report or
approval is created for a rejected link. No WHOOP credentials are changed.

Client diagnostics are allowlisted and labeled client-reported; arbitrary
messages, provider bodies, headers, tokens, URLs and health values are refused.
An optional request ID must belong to this member's own recent diagnostics.
Approval is bound to the entire canonical payload, including link_id. No real
member report was submitted as a deployment test.

## Validation

- 449 standard tests passed, including seven new structured-report tests and
  twelve Notion tests. The two existing CRLF-sensitive text fixtures were
  temporarily normalized to LF for the run and restored byte-for-byte.
- 11 real pinned-provider OAuth integration tests passed.
- esbuild resource bundle compiled successfully; git diff --check passed.
- Read-only production schema inspection confirmed all reporter tables and
  that all three stored WHOOP connections have a generation record.
- Post-release protected-resource metadata returned 200; unauthenticated MCP
  retained its expected 401 Bearer challenge.
- A real authenticated `get_capabilities` succeeded through the connected
  WHOOP Lens MCP app after its connector authentication completed.
- The disabled Notion start route returned 503. No Notion migration was
  applied, no Notion app credentials were installed, and Notion remains off.

## Production record

- Worker: `whoop-lens` (MCP resource only).
- Released at 23:41:05 UTC (6:41 p.m. Chicago).
- Version: `ff7bebdf-cab0-46f2-9f0c-8031e32ac566`, 100% traffic.
- Deployment: `bf01d624-33d0-432a-9080-70b29b8ad593`.
- Bundle SHA-256: `5e30ad67417ed3dff9ebe04309dc5bb3d025b57f2af9d3e66fc1711db7e49eb4`.
- Rollback version: `51d0ab11-d16a-49a0-9d20-8a5b2d663476`.
- Existing bindings, secret bindings, feature flags, compatibility date,
  observability and routes were preserved. Added `NOTION_ENABLED=false`.
- No migrations, member credential changes, identity edits or grant deletions
  were performed for this release. The auth Worker was not redeployed.

The bundle includes optional Notion code staged behind a disabled flag.
Per-member OAuth setup and the remaining external prerequisites are documented
in [notion.md](notion.md). There is no shared member database or Notion token.

Clients cache tool inventories; refresh WHOOP Lens's tool list to discover the
new tools. Removing the connection or disconnecting WHOOP is unnecessary.
