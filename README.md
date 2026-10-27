# WhoopLens

Private MCP for a person's own WHOOP and separately authorized Health Connect data. WHOOP access is read-only; explicit account tools can connect/disconnect WHOOP, import Health Connect records, and manage phone-ingest consent and tokens. It can also read Samsung Health records uploaded for that same person. This is an independent project. It is not affiliated with WHOOP.

## Production features available to all active members

Verified October 15, 2026: all completed private MCP features are enabled server-wide. These features are not restricted to the developer account. Every member uses their own authorization, records, consent, usage allowance and cached digests. New users still require invitation, active membership and applicable connection consent; enabling a feature does not grant consent on their behalf.

| Completed feature | Production status | Member requirements |
| --- | --- | --- |
| Private MCP discovery and tool execution | Enabled | Authenticated active membership |
| OAuth sign-in and consent | Enabled | Complete the private sign-in and consent flow |
| WHOOP connection, refresh and supported record reads | Enabled | Connect your own WHOOP account |
| AI summaries and personal AI usage | Enabled | Supported account records; normal usage limits and template fallback apply |
| Experimental WhoopLens stress estimates | Enabled | Sufficient valid personal baseline data; not official WHOOP Stress Monitor |
| Weekly digests | Enabled | Own WHOOP connection and available history; requested on demand |
| Health Connect file imports | Enabled | Explicit file-storage consent |
| Health Connect companion/webhook ingestion | Enabled | Own ingest token, phone permissions and webhook consent |
| Stored Samsung Health and reviewed medical-context reads | Available | Existing authorized records for that member; no new importer is implied |
| Autoimmune/flare context and daily journal | Enabled | Separate explicit journal-storage consent |
| Descriptive personal flare comparisons | Enabled | Separate analysis consent, own journal labels and WHOOP connection |
| Journal edit, delete, analysis pause and withdrawal | Enabled | Own journal and the applicable confirmation/revision |

The production resource Worker is version `6ae55a84-64f3-4369-aaaf-ebae3750a7e4`, serving 100% of traffic from code commit `ae57926` (PR #55). All eleven resource feature flags and both OAuth issuer flags were verified enabled. Public workers.dev and preview access remain disabled. The last runtime release passed 338 synthetic tests and all three applicable CI workflows.

Flare predictions, automated flare notifications and unfinished importers remain outside the completed feature set. Global AI-budget visibility remains an operator-only permission; each member can read their own usage. Existing clients may need to refresh their MCP discovery to expose new tools. See the [flare release verification](cloudflare/docs/flare-journal.md#production-verification--2026-10-15) and [audit record](cloudflare/docs/private-mcp-audit-20261015.md).

## Install and connect: member setup guide

Start here if you are joining WhoopLens. You do not need to clone this repository, deploy a server, obtain an API key or enter a WHOOP client secret. The private server is already hosted. Complete step 1, then connect only the features you want.

### 1. Install the private plugin in ChatGPT

**Need approval first?** Open [Request a WhoopLens seat](https://auth.whooplens.tech/request-seat), enter your name and the email you want approved, optionally add a short message, agree to be contacted, complete the human verification, and select **Request a seat**. Requests are sent to `whoop-lens@outlook.com` for owner review. Users denied by the Cloudflare email allowlist are directed to this page. A request never grants access or reserves a seat; wait for owner approval before installing. Do not include health information. See [seat-request setup and status](cloudflare/docs/seat-requests.md).

Before starting, ask the WhoopLens owner to invite and activate the email address you will use. Creating a plugin connection does not create a WhoopLens membership. Your ChatGPT account/workspace must also allow custom MCP plugins.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins). If the installation controls are missing in the mobile app, use ChatGPT in a browser.
2. Select **+**, then **Add custom MCP server**.
3. Enter the following connection settings:

   | Setting | Value |
   | --- | --- |
   | Name | `WhoopLens` |
   | Server URL | `https://whooplens.tech/mcp` |
   | Authentication | OAuth |
   | Client ID | Leave empty |
   | Client secret | Leave empty |

4. Review the connection notice and create/install the plugin. When sign-in opens, use your invited email address and enter the Cloudflare Access code sent to that inbox. Approve the WhoopLens consent screen.
5. Open a new chat, type `@`, and select **WhoopLens**. If you chose a different display name, select that name.
6. Send this first check:

> Use WhoopLens get_capabilities. List all pages of available features and tell me which need my connection, consent or records.

**Success looks like:** a capability response from the private server. WHOOP may still need connecting; that is step 2. Menu labels can vary by client. The [official ChatGPT MCP installation guide](https://developers.openai.com/plugins/build/app-quickstart#connect-your-mcp-server-in-chatgpt) describes the current installation flow.

**Already installed but missing new tools?** Refresh the connection from its [plugin detail page](https://chatgpt.com/plugins), then open a new chat and select it again. If your client has no refresh control, remove and re-add the same MCP connection. This refresh is separate from disconnecting WHOOP or deleting stored health records.

The private OAuth sign-in server is `https://auth.whooplens.tech`. WHOOP connect is on for active members; complete the separate WHOOP approval below to link your records.

### 2. Connect your WHOOP account

1. Select WhoopLens in the chat and send:

> Use WhoopLens connect_whoop to give me my WHOOP authorization link.

2. Open the returned link, sign into your own WHOOP account, and approve the requested read access. Complete the redirect back to WhoopLens.
3. Return to the chat and verify:

> Use WhoopLens get_profile and get_recovery. Confirm the profile is mine and show the dates of the returned recovery records.

**Success looks like:** your profile and available measurements, or an explicit no-records result. Installing the plugin alone does not connect WHOOP. An existing connection on the older Supabase connector is separate and is not copied here.

Once connected, these features require no additional accounts:

| Feature | Copy-paste prompt |
| --- | --- |
| Body measurements | Use WhoopLens get_body_measurements. |
| Recovery, HRV and resting heart rate | Use WhoopLens get_recovery with auto_page true and show the returned dates. |
| Sleep | Use WhoopLens get_sleep with auto_page true. |
| Workouts | Use WhoopLens get_workouts with auto_page true. |
| Cycles and strain | Use WhoopLens get_cycles with auto_page true. |
| Compare metrics | Compare my returned WHOOP recovery, sleep and strain records by date. Flag missing dates and separate observations from hypotheses. |

History tools return pages. `auto_page: true` fetches up to four pages (100 records) per call, not unlimited history. To continue, call the same tool again with the returned `next_token`, with or without `auto_page`, until `complete` is true. On the Cloudflare server `next_token` is an opaque cursor sealed to your account and that history category; it expires after one hour and cannot be used by another member or on another category.

### 3. Use AI summaries, experimental stress and weekly digests

These are already enabled for all active members. No separate AI account or API key is required.

| Feature | Copy-paste prompt | What to expect |
| --- | --- | --- |
| AI summary and charts | Use WhoopLens get_recovery with auto_page true and summary true. Show the summary, chart_data and insights. | Your returned measurements with a model-selected or deterministic template summary. Charts depend on the chat client. |
| Sleep summary | Use WhoopLens get_sleep with auto_page true and summary true. | Summary of your returned sleep records. |
| Experimental stress estimate | Use WhoopLens get_recovery with summary true. Show chart_data.stress_estimate, including its date, value, band, confidence and missing-data explanation. | A WhoopLens experimental calculation when enough valid baseline data exists; it is not official WHOOP Stress Monitor. |
| Personal AI usage | Use WhoopLens get_ai_usage. | Your allowance and usage for the current UTC day. |
| Weekly digest | Use WhoopLens get_weekly_digest with no arguments, then show its charts and insights. | The latest completed Monday–Sunday UTC week. This is on demand, not an automatic notification subscription. |

WHOOP Stress Monitor history is not in the official WHOOP developer API. The experimental estimate does not provide official stress-zone durations or an intraday Stress Monitor timeline.

Stress requires at least 14 valid baseline days in the preceding 30-day window and sufficient current measurements. Missing data can make it unavailable even though the feature is enabled. A template summary is a supported fallback when model quota or service availability prevents a model call.

### 4. Connect Android Health Connect automatic sync

This is optional and separate from WHOOP authorization. Use your own Android phone and ingest token. The supported companion path is **HC Webhook**, not the unfinished Android app in this repository.

1. On the phone, make sure your source app writes the records you want to Android Health Connect. Check Health Connect's app permissions and confirm records exist there.
2. Install HC Webhook from its [official GitHub releases](https://github.com/mcnaveen/health-connect-webhook/releases), or add that repository in Obtainium. The integration was verified with the FOSS build `app-foss-release.apk`, package `com.hcwebhook.app`, version 1.9.22; this is a compatibility reference, not a claim about the latest release.
3. Give HC Webhook permission to read the supported data types you want to send: steps, sleep, heart rate and exercise. Allow background reading if you want background sync. Set the sync interval to 15 minutes and leave sample resolution at the app default.
4. In the WhoopLens chat, send:

> I consent to storing my Health Connect webhook records. Use issue_health_connect_ingest_token with consent enable-health-connect-webhook.

5. In HC Webhook, add **one** webhook with these settings:

   | Setting | Value |
   | --- | --- |
   | URL | `https://whooplens.tech/api/health-connect/webhook` |
   | Method / format | POST / JSON |
   | Custom header name | `Authorization` |
   | Custom header value | Paste the exact `header_value` returned by the tool, including `Bearer ` once |

6. Run a manual sync and check the app's Webhook Logs. Then verify the stored data in chat:

> Use WhoopLens get_health_connect. Show the returned record types, dates and sources, and follow pagination if needed.

**Success looks like:** a successful delivery plus supported records returned for your account. HTTP 200 alone does not prove records were stored: unsupported types can be skipped and malformed records rejected. Check any stored/rejected/skipped counts in the response and the readback. Background delivery depends on Android permissions and scheduling.

The token is shown once. Keep it private; do not post it in issues or screenshots. Issuing a new token replaces the old one, so update the phone header whenever you rotate it. For payload limits and retry details, see [HC Webhook setup](docs/HC_WEBHOOK_SETUP.md).

### 5. Import a Health Connect file instead

Skip phone-sync setup if you only want a one-time file import. This path accepts **WhoopLens Health Connect v2 JSON**, not an arbitrary Samsung export, CSV or medical document.

1. Select a compatible file that contains your own records and attach it, or paste its JSON into the chat.
2. Send:

> I consent to storing this Health Connect file. Use import_health_connect_file with consent store-health-connect-file and the file's exact JSON as file_json. Report the import result.

3. Verify with `get_health_connect`. You can request `summary: true` for a summary of the stored records. Importing a file does not enable background phone sync.

### 6. Set up the autoimmune/flare journal

This optional journal stores only what you explicitly provide. It does not infer a diagnosis from chat history. Storage and personal analysis are separate choices; read the [journal privacy and retention details](cloudflare/docs/flare-journal.md) before opting in.

1. To enable **journal storage only**, send:

> I consent to storing my private flare journal. Use set_flare_consent with storage_consent store-flare-journal.

2. If you also want **personal WHOOP comparisons**, send this separate opt-in after connecting WHOOP:

> I consent to storing my flare journal and analyzing its labels against my own WHOOP records. Use set_flare_consent with storage_consent store-flare-journal and analysis_consent analyze-flare-patterns.

3. Provide only the context you want saved:

> Help me use save_flare_context. Ask me for the condition names and optional medication context I want stored, then save only what I provide.

4. Add a daily entry:

> Help me use save_flare_entry. Ask me to confirm the UTC calendar date and my flare label: yes, no or unknown. Offer optional severity from 0 to 10, symptoms, confounders and notes. Do not infer a label for me.

5. Read it back with `get_flare_journal`. When editing an existing entry or context, have the host read its latest revision before saving the replacement.
6. Once you have explicit flare and non-flare labels and WHOOP measurements, request a comparison:

> Use analyze_flare_patterns for my journal and WHOOP records. Ask me for start and end dates in UTC, no more than 90 days apart inclusively. Show coverage, missing data and descriptive comparisons. Do not present them as flare predictions.

**Success looks like:** a saved-entry confirmation, then your own entry on readback. Analysis may have too little data for a comparison. Unknown or unlogged days are not non-flare controls. The feature reports insufficient evidence for a flare warning; there is no prediction or notification subscription to activate.

### 7. Other record sources

`get_samsung_health` reads separately stored Samsung Health uploads. `get_medical_context` reads reviewed medical-context entries already stored for your account. Neither tool connects a new source or imports a medical document. If they return no records, there is no completed self-service importer to enable for those tables. Samsung-origin records delivered through Health Connect are read using `get_health_connect` instead.

### Pause, disconnect or delete

Use these only when you intend the stated change. Removing the plugin from your chat client is not a request to delete server records.

| Intended change | Prompt / tool |
| --- | --- |
| Disconnect WHOOP from WhoopLens | Use disconnect_whoop for my account. |
| Stop Health Connect phone delivery but keep stored records | Use revoke_health_connect_ingest_token with confirm revoke-health-connect-ingest-token. |
| Delete stored Health Connect records and stop delivery | Use withdraw_health_connect_import with confirm delete-my-health-connect-records. |
| Pause flare analysis but retain the journal | Use pause_flare_analysis with confirm pause-flare-analysis. |
| Delete one journal entry | Read my journal, confirm which date I want deleted, then use delete_flare_entry with that entry_key, its current expected_revision, and confirm delete-flare-entry. |
| Delete the whole flare journal and context, withdrawing both consents | Use withdraw_flare_journal with confirm delete-my-flare-journal. |

These operations apply only to the signed-in account. Deleting server records does not erase copies already returned in chat.

### Setup troubleshooting

| What you see | Next step |
| --- | --- |
| Custom-plugin installation is unavailable | Check the browser version of ChatGPT and your workspace's custom-MCP permissions. A WhoopLens invitation does not grant ChatGPT workspace permissions. |
| Access denied or no usable sign-in | Use the invited email; ask the owner to confirm active membership. |
| Plugin responds but WHOOP is disconnected | Complete step 2's returned authorization link, then read your profile. |
| A new tool is missing | Refresh the plugin connection, open a new chat and select it again. |
| HC Webhook returns 401/403 | Check the exact Authorization header, active membership and ingest consent. If the token was revoked/replaced, deliberately issue a replacement and update the phone. |
| HC Webhook returns 413 | Reduce the upload window or sample detail; retrying the same oversized payload will not help. |
| HC Webhook returns 503 | Retry the upload; do not rotate the token just for a transient server failure. |
| HC delivery succeeds but the read is empty | Check source-app Health Connect permissions, supported types, response counts and the dates sent. |
| Stress or flare comparisons lack data | Check the returned coverage. Feature activation cannot supply missing measurements or user labels. |


## Retired Supabase connector

The Supabase connector and its GitHub Pages sign-in, consent and **Connect WHOOP** controls are retired. Use the Cloudflare connector at `https://whooplens.tech/mcp`: sign in with a Cloudflare Access email one-time PIN, approve the consent page at `https://auth.whooplens.tech`, then run `connect_whoop` in the chat to link WHOOP (step 2 above). The old browser workspace page depends on that retired sign-in and is no longer linked.

## Capabilities

Connected clients can call **get_capabilities**. The deployed catalog is the source of truth. See [the capability directory](docs/CAPABILITIES.md).

## AI summaries and experimental stress

WHOOP body-measurement, recovery, sleep, workout, and cycle reads, and stored Health Connect reads, accept optional `summary: true` when `AI_SUMMARY_ENABLED` is exactly `"true"`. Raw records and paging remain available independently. The Worker calculates the facts; Workers AI selects one to three precomputed statements by index. Free-form model prose is never published. Invalid selections, quota limits, analytics failures and model failures return a deterministic template. Stress wording, dates, band, confidence and the experimental-source label are rendered by the Worker, never generated by the model.

Checked-in Wrangler defaults stay disabled. Production uses separately verified bindings; see [audit and release record](cloudflare/docs/private-mcp-audit-20261015.md). No automatic rollout, signup, or new source consent is implied by enabling a feature.

A summary object keeps this field order: `text`, `stats`, `model`, `generated_at`, `coverage`, `status`, `chart_data`, and `insights`. A template fallback also sets `fallback_reason` to `account_check_failed`, `quota`, `timeout`, `filter`, `injection`, or `model_error`. That same word is written to the log, with no secrets or measurements. `chart_data` has `date_range`, `record_count`, `series`, `sleep_recovery`, and `stress_estimate`. Each series is one allowlisted metric from that same response: `metric`, `name`, `unit`, `date_range`, `record_count`, `stats` (`min`, `max`, `mean`, `first`, `last`, `change`), `baseline`, `points`, `gaps`, and `gaps_truncated`. `points` are ordered by date. A day inside the series span with no sample is `{date, value: null}` and is also listed in `gaps`, so a chart does not draw across it. The data does not say whether that day was unworn or unsynced. Spans longer than 400 days set `gaps_truncated` and omit the filled days. `baseline` compares the latest point with the 30 UTC days before it: `window`, `days`, `sample_count`, `median`, `typical_range` (`low` and `high`, the 25th and 75th percentiles when at least four samples exist), and `complete`. When the read can page WHOOP history, those 30 days are fetched. When it cannot, `complete` is false and `days` is only the span actually present. `insights` are short factual sentences from those stats, including the baseline comparison when it exists. They describe the measurements. The template summary includes the same `chart_data` and `insights` when the model is not called.

`sleep_recovery` pairs a night's sleep with recovery by `sleep_id`; legacy records without IDs use the documented next-day fallback. `chart_data.stress_estimate` is present only when both `STRESS_ESTIMATE_ENABLED` and `AI_SUMMARY_ENABLED` are exactly `"true"`. It is a calculated, experimental daily WhoopLens index, not WHOOP Stress Monitor. It uses the same member's HRV, resting heart rate, sleep and respiratory measurements against their prior 30 days, requiring at least 14 valid baseline days. See [formula, units, confidence and limitations](cloudflare/docs/stress-estimate.md). No official stress-zone durations or intraday WHOOP stress endpoint are provided. Malformed, failed or truncated history remains incomplete rather than being reported as a complete empty history.

`get_ai_usage` is listed only while `AI_SUMMARY_ENABLED` is exactly `"true"`. It returns the signed-in account's used, cap, and remaining neurons for the current UTC day. The global counter is added only when the verified user id equals `WHOOP_LENS_DEVELOPER_USER_ID`. The tool does not accept another user's id and does not return other accounts. `get_weekly_digest` is listed only while `WEEKLY_DIGEST_ENABLED` is exactly `"true"`. The checked-in flag defaults to `"false"`; live settings are recorded separately. A compatible host can pull the digest; scheduled-task connector availability depends on that host. WhoopLens does not send it, and no cron or schedule is configured. Call the tool with no other inputs. The optional `week_ending` argument is a `YYYY-MM-DD` date and is the last day of a seven-day window. When it is omitted, the window is the most recent complete Monday–Sunday week in UTC, ending on the previous Sunday. The response has `text`, `chart_data`, `insights`, and `status` (`model` or `template`) for that account's recovery and the prior night's sleep. Sleep is read from the day before the week as well, because a sleep can start the previous UTC day. The tool pages until that week is covered. The first complete, non-empty call for an account and week builds the digest. Cache keys include AI/stress mode and a format version. Expired generation claims cannot overwrite or release a newer claim. A local WHOOP disconnect invalidates that account’s cached digests and in-flight claims; cached reads require an active connection. Complete baseline retrieval is required for persistent caching. When summaries are also on, that call uses the same neuron quota and safety rules, and the week is cached only when `status` is `model`. A template fallback, including a full quota or a failed or stale analytics read, is returned and not cached, so a later call can try again. When summaries are off, the template is cached. A later call for a cached week returns that digest and does not spend more neurons. An empty week or a pull that stops before the week is covered is not cached, so a later call can try again. Migration `cloudflare/migrations/0011_ai_weekly_digest.sql` stores that cache. The production table has been verified present. A suggested ChatGPT scheduled task is: "Every Monday 8 AM, call WhoopLens get_weekly_digest and chart it."

The shared daily budget also counts Workers AI neurons used elsewhere on the same Cloudflare account. Before reserving a model call, the Worker reads today's UTC total (00:00 inclusive through the next midnight, exclusive) from the GraphQL Analytics API dataset `aiInferenceAdaptiveGroups`, summed as `totalNeurons`. The read uses the Worker secret `AI_ACCOUNT_ANALYTICS_TOKEN`, which needs only Account Analytics Read. The account id is `AI_ANALYTICS_ACCOUNT_ID`, a 32-character hex value supplied as a Wrangler var or secret when summaries are enabled. Neither value is committed. The room left for a call is the minimum of the per-user room (2,500), this Worker's global room (7,500), and 10,000 minus the account-wide total minus a 500 neuron safety margin. Migration `cloudflare/migrations/0010_ai_account_snapshot.sql` caches that total in D1 for 3 minutes. Reservations made after the snapshot are subtracted from the remaining room so analytics lag is not counted twice. `ANALYTICS_STALE_MS` is 10 minutes, measured from the fetch time or an explicit data-freshness watermark. The newest inference time is only the last counted call, so a quiet account whose last call was hours ago still gets a ceiling when the fetch is fresh. Local reservations made after that call are added to the analytics total. If the call time is missing, the ceiling uses the max of the analytics total and this Worker's local counter. A watermark older than 10 minutes, or a failed fetch, returns the template summary and does not call the model. If the analytics call fails, or a cached snapshot cannot be refreshed, the Worker also returns the template and does not call the model. `whoop-lens` and the resource Worker need the secret when the flag is turned on. The auth Worker does not. The deployed AI usage and digest paths use the production schema introduced by migrations `0009_ai_usage.sql` through `0012_ai_usage_event.sql`; their release verification is documented in the audit record.

WhoopLens reads profile, body measurements, recovery, sleep, workouts, and cycles. Charts and outside research depend on the connected AI host.

## Seats

A new WHOOP connection on the Supabase connector needs an open seat. There are 9 public seats and 1 developer seat. A person who already has a connection can reconnect and keep using MCP. A person without a connection cannot finish a new one when the matching seat is unavailable: `/connect`, `connect_whoop`, and the WHOOP callback all stop before storing tokens.

The developer seat is the Supabase Auth user id in the function environment variable `WHOOP_LENS_DEVELOPER_USER_ID`. It is not stored in git. If that variable is unset or is not a UUID, nobody gets the developer seat and only the 9 public seats exist. The designated user can connect while public seats are full, unless another connection already has `seat_role = developer`. Changing the variable does not move an existing developer row; clear or reconnect that row first. Until the designated user reconnects, an older connection stays `public` and counts as a public seat.

Someone past the public cap gets HTTP 403 with `code` `seat_full`. The callback sends the browser back to the Pages app with `waitlist=1` and does not exchange the WHOOP code. No WHOOP tokens are stored for that attempt.

## Waitlist

When public seats are full, the Supabase function stores one `whoop_waitlist` row for that Supabase user. The row can contain only:

- `user_id`
- `contact_email` (the Supabase account email, and only when it matches the normal address pattern)
- `destination`, which is always `whoop-lens@outlook.com`
- `created_at`

It does not contain WHOOP access tokens, refresh tokens, client secrets, authorization codes, or health data. Logs for this path do not contain those values or the email. This repository does not send the notice. Apply `supabase/migrations/20261004120000_whoop_connection_seats_and_waitlist.sql` before deploying the function, then read the table when you want to mail that destination yourself.

## Logging

The Supabase function writes one JSON object per metric through `console.log`. Fields are limited to the metric name, outcome, status, route, duration, tool name, seat kind, page count, and Supabase user id. Tokens, authorization headers, OAuth codes, refresh tokens, emails, and health payloads are not fields on that object.

## How it is hosted

The `docs/` folder is the public GitHub Pages site: [https://astrasler.github.io/WHOOP-Lens/](https://astrasler.github.io/WHOOP-Lens/), also built for `https://www.whooplens.tech` from `site/`. Its old Supabase sign-in and consent controls are retired; sign-in and consent for the live connector happen at `https://auth.whooplens.tech`. The Supabase notes below describe the retired function until it is removed.

WHOOP requests for the existing connector are handled by the Supabase edge function `whoop-mcp`. Its source is `supabase/functions/whoop-mcp/` (`index.ts` plus `handler.mjs` and `challenge.mjs`). Those files are the bytes that should be deployed. `supabase/whoop-mcp.SOURCE.sha256` is a checksum of them, and `node --test` fails if the files drift from that lock. Supabase processes those requests.

WHOOP access and refresh tokens for that connector are encrypted per Supabase user and stored in Supabase. They are not stored only in the browser. The Pages app keeps the Supabase sign-in session in memory for the open tab. Those tokens are not copied to Cloudflare.

Runtime secrets for the Supabase function stay in the Supabase function environment. Do not commit tokens, WHOOP credentials, or service keys. When OpenAI issues a domain-verification token, set `OPENAI_APPS_CHALLENGE` in that environment. A GET to `/.well-known/openai-apps-challenge` returns that value as plain text. If the variable is missing, the route returns 404.

`supabase/config.toml` sets `verify_jwt = false` for `whoop-mcp`. Leave it false. The function checks the Supabase user and the WHOOP OAuth state itself, and the WHOOP callback does not carry a gateway JWT.

The private connector is the Cloudflare Worker `whoop-lens` on `whooplens.tech`. Its issuer is the Worker `whoop-lens-auth` on `auth.whooplens.tech`. GitHub Workers Builds on `main` do not auto-run `npx wrangler deploy`. Cloudflare preview builds are off, so a push does not run `npx wrangler preview` or add a failed Workers Builds check. Checked-in Wrangler configurations keep activation flags off as safe defaults. A production deployment must explicitly preserve live bindings and flags; deploying those defaults directly could disable completed features.

## Tests

```bash
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs
```

GitHub Actions runs that command on every push and every pull request. The tests do not need a live WHOOP account or real secrets. They do not prove production isolation against two live WHOOP accounts; they prove the function filters by the signed-in Supabase user when the database and WHOOP client are faked.

Where the Cloudflare sources are present, also run:

```bash
node --test cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs
```

## WHOOP access

Connecting WHOOP on the Supabase connector requests these read scopes: `read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`, plus `offline` so the function can refresh access. The plugin does not request write access to WHOOP.

## Samsung Health

`get_samsung_health` reads Samsung Health records stored for the signed-in Supabase user, including sleep, heart rate, activity, and related measurements. Those records are a separate source from WHOOP.

## Revocation

Revoke the integration in the WHOOP account settings to stop future WHOOP reads. Revocation does not delete information already returned to ChatGPT or Codex. Sign out of the Pages app to drop the in-memory Supabase session. A Supabase user can also be disabled with the optional `whoop_members` kill switch. A new WHOOP connection still needs an open seat, as described above.

See the [privacy statement](https://astrasler.github.io/WHOOP-Lens/privacy/) for how data is handled. The same text is in [Privacy.md](Privacy.md).

## Published pages

- Website: https://astrasler.github.io/WHOOP-Lens/
- Privacy: https://astrasler.github.io/WHOOP-Lens/privacy/
- Terms: https://astrasler.github.io/WHOOP-Lens/terms/
- Support: https://astrasler.github.io/WHOOP-Lens/support/
- Private MCP: https://whooplens.tech/mcp

Production status (2026-10-15): private MCP includes the repairs through PR #54 and opt-in flare journal/personal comparisons from PR #55 (code commit `ae57926`). AI summaries, experimental stress estimates, weekly digests, WHOOP integration, and Health Connect ingestion are enabled. See [the audit and deployment record](cloudflare/docs/private-mcp-audit-20261015.md) for tests, version IDs and live-verification limits.

### Opt-in flare journal and personal comparisons

The private MCP implementation includes a separately gated condition/symptom journal and descriptive comparisons with the same member's WHOOP records. Storage and analysis require separate explicit consent. Users can edit, delete, pause analysis or withdraw and delete the journal. It does not predict flares, train a model or send notifications. See [consent, tools, calculations and release requirements](cloudflare/docs/flare-journal.md). `FLARE_JOURNAL_ENABLED` defaults off in repository configs and is enabled in production as of 2026-10-15. Activation does not enroll anyone.
