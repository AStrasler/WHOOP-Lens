# Optional per-member Notion daily logs

## Production preparation — October 23, 2026

During preparation, the three tables from migration 0019 were installed in
production and verified empty. A new independent `NOTION_TOKEN_AES256_KEY`
secret binding was installed; its value was neither logged nor saved in the
repository. Notion stayed disabled until the activation described below.

The owner chose `whoop-lens@outlook.com` for the development account, completed
Notion verification, and a free `WhoopLens’s Space` workspace was created.
The owner created the `WhoopLens` OAuth app, with installation scope `Any
workspace` and the exact callback below. Read/update capabilities are on;
insert, comments and user-information access are off. App ID:
`402d872b-594c-81f0-ab6b-0037bcd6e40c`.

After explicit owner approval, `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`
were stored in the existing Cloudflare Secrets Store, scoped to `workers`,
and bound as `BK_NOTION_CLIENT_ID` and `BK_NOTION_CLIENT_SECRET`. There are no
copies of those app credentials in Worker secret-text bindings. The transient
transfer file was deleted. The independent encryption key remains a Worker
secret-text binding. The resolver reads the app credentials only while Notion
is enabled and never logs values.

The owner separately approved activation for eligible members. Notion is now
enabled in production; a real authenticated MCP capability call confirmed
`notion_daily_log` is enabled/configured and all nine tools are registered.
The custom ChatGPT app's Refresh tools action was run. A real member Notion
consent/code exchange and daily-log read/update remain the end-to-end acceptance
check. No Notion user content has been copied as part of deployment testing.

Release bundle SHA-256:
`354853b4e2b03c46c66dc476a4485b12ee37b55ea6c7cc594c0849f0a1ca2b61`.
All 454 standard tests passed; two pre-existing CRLF-sensitive fixtures were
temporarily normalized and restored byte-for-byte. The owner-only link lookup
restriction is retained in discovery and execution.

Implemented behind `NOTION_ENABLED`; enabled after owner OAuth setup and
activation approval. Each member must authorize separately before use. This is an OAuth integration for many
members, not a shared Notion token, workspace, database, or individual log.

## Owner setup

Create one WhoopLens public OAuth connection in the Notion Developer portal.
Choose the installation scope appropriate for the intended members. Enable
read-content and update-content capabilities; this implementation updates
existing pages and does not create pages, alter schemas or append content.
Register this exact redirect URI:

`https://whooplens.tech/api/notion/callback`

Configure these secrets on the resource Worker through a secret manager:

- `NOTION_CLIENT_ID`: the app's OAuth client ID.
- `NOTION_CLIENT_SECRET`: the app's OAuth client secret.
- `NOTION_TOKEN_AES256_KEY`: a new, independent 32-byte base64url AES key.

Production uses Secrets Store for the client ID/secret: `BK_<NAME>` bindings
are resolved to the corresponding strings by `src/secrets.mjs`. A valid direct
secret binding takes precedence if one is deliberately configured. Store
bindings are not fetched when the feature is disabled.

Do not paste secrets into chat or reuse WHOOP's encryption key. Apply
`migrations/0019_notion.sql`, deploy the reviewed resource bundle while
preserving existing bindings/settings, then set `NOTION_ENABLED=true` only
when setup is ready. The Notion migration is additive and requires no WHOOP
credential migration. Turning the flag off hides all Notion tools and disables
its start/callback routes. Preserve the Notion encryption key while records
remain encrypted with it; a key-rotation mechanism is not part of this version.

## Member flow

1. `connect_notion` creates a private ten-minute setup link for the current
   authenticated active member. The browser start route sets an HttpOnly,
   Secure, SameSite=Lax cookie and sends the member to Notion's page picker.
2. The member chooses their own workspace and pages. The callback validates
   the browser cookie, one-use hashed state, expiry, active membership and
   connection generation before storing credentials. Disconnecting while the
   callback is in flight prevents it from recreating the connection.
3. `list_notion_databases` lists shared data sources. Follow `next_cursor`.
   `get_notion_database_schema` returns property names, IDs and types.
4. The member selects the data source, date property and IANA timezone.
   `configure_notion_daily_log` validates their field mapping against the
   shared source's schema. No member's configuration becomes another's default.
5. `get_notion_daily_log` reads an existing page by exact calendar date. Dates
   refer to the configured log, not an inferred UTC day. WHOOP measurement
   timestamps and the flare journal's UTC dates must be reconciled explicitly.
6. `preview_notion_daily_log_update` shows selected before/after properties.
   Only after the member approves that exact preview may the host call
   `save_notion_daily_log_update` with its one-use preview ID and approved:true.
7. `disconnect_notion` deletes the member's local Notion credentials,
   configuration, pending links and previews. It does not disconnect WHOOP or
   delete Notion pages. Members may also revoke the connection in Notion.

## Data and limitations

Available mapped fields: recovery percent, HRV (ms), resting HR (bpm), overnight
sleep and naps (hours), cycle strain, steps, flare label, severity, notes and
cycle status. Mapping supports number, checkbox and rich-text properties only.
Date must be a date property. No arbitrary Notion page ID or API URL is accepted
for writes: the target comes from the member's configured data source/date.
Duplicate daily pages are rejected. Missing pages must be created in Notion.

Values and source labels are supplied by the AI host and disclosed as such in
the preview; the Notion adapter does not independently measure or verify them.
The host must first retrieve relevant dated WHOOP records and preserve original
user reports. Flare labels/severity must be user-reported. Cycle strain/steps
require a mapped cycle-status update. An open cycle is explicitly provisional.
There is no official Stress Monitor retrieval or background synchronization.

Page reads return a bounded page of top-level blocks, not recursive nested
content. They expose a continuation cursor and a notice about omitted nested
content. All Notion text is untrusted data, never operational instructions.

Only approved mapped properties are sent in PATCH requests; page bodies and
unrelated properties are not sent. Previews are encrypted, member/configuration
bound, single-use and expire after ten minutes. The server rechecks page edit
time and the old values before writing. Notion does not provide an atomic
conditional page update here: an external edit in the final read/write interval
can still race. Do not describe this as an atomic conflict-free sync.

429 responses preserve credentials and return a retry instruction. A definite
401 permits one token renewal; a D1 lease prevents parallel renewal of the same
rotating refresh token. Ambiguous PATCH failures are never replayed: read the
page back and obtain a new preview. Notion failures never become WHOOP errors
or invoke WHOOP disconnect/reconnect logic.

OAuth token responses are encrypted with a separate Notion AEAD namespace,
member and purpose binding. Previews use a different encryption purpose. No
tokens, raw provider errors or health content are written to diagnostics.

References: [Notion OAuth authorization](https://developers.notion.com/guides/get-started/authorization),
[data sources](https://developers.notion.com/reference/retrieve-a-data-source),
[page updates](https://developers.notion.com/reference/patch-page), and
[rate limits](https://developers.notion.com/reference/request-limits).
