# WHOOP Lens

Private, read-only MCP for a person's own WHOOP data. It can also read Samsung Health records that were uploaded for that same person. This is an independent project. It is not affiliated with WHOOP.

## Private connector

Add WHOOP Lens in ChatGPT as a custom MCP connector:

1. Name it **WHOOP Lens**. Server URL: `https://whooplens.tech/mcp`.
2. Choose OAuth and leave client ID and client secret empty. ChatGPT registers itself with `https://auth.whooplens.tech`. The issuer accepts dynamic registration at `/oauth/register` and client-metadata documents. Scope is `mcp:read`. Protected resource metadata is `https://whooplens.tech/.well-known/oauth-protected-resource/mcp`.
3. Sign in with the Cloudflare Access email one-time code. The Worker accepts that Access identity only when it is already linked to an active member.
4. Approve the consent screen.

ChatGPT keeps a connector's discovery result until that connector is removed. After a server discovery change, remove WHOOP Lens and add it again at the same URL.

An unauthenticated request receives an OAuth challenge. `https://whoop-lens.whoop-lens.workers.dev` stays disabled. WHOOP refresh tokens on this connector stay separate from the Supabase connector. The password form on the GitHub Pages site belongs to the Supabase connector.

### Link WHOOP

The WHOOP client id and secret are saved on the Worker, and WHOOP connect is on. In ChatGPT, call `connect_whoop` and open the authorization URL it returns. Approve read access on WHOOP's page. WHOOP redirects the browser to `https://whooplens.tech/api/whoop/callback`. The WHOOP app must allow that redirect. The callback stores the connection for the member who started `connect_whoop`. A connection exists only after that approval.

### Health Connect file

`import_health_connect_file` stores one WHOOP Lens Health Connect v2 JSON file for the signed-in account. The consent argument is `store-health-connect-file`. The Worker stores the file when `WEB_HEALTH_IMPORT_ENABLED` is true. That variable is `false` in the checked-in Wrangler file, so confirm the live Worker before relying on the tool. `get_health_connect` reads rows already stored for the account. `withdraw_health_connect_import` with confirm `delete-my-health-connect-records` deletes those rows, records the withdrawal, and revokes phone ingest tokens.

### Phone sync

Automatic delivery from the Health Connect Webhook app is deployed. On Oct 12, 2026, `cloudflare/migrations/0007_health_connect_ingest.sql` was applied to the production D1 database `whoop-lens-migration`, and `whoop-lens` version `3ce33b05` went live with `HEALTH_CONNECT_WEBHOOK_ENABLED=true`. The checked-in Wrangler config still defaults the flag to `false`, so every deploy must pass `--var HEALTH_CONNECT_WEBHOOK_ENABLED:true` with the other production flags.

When that gate is open, the phone setup is:

1. Install the free FOSS app with Obtainium from [github.com/mcnaveen/health-connect-webhook](https://github.com/mcnaveen/health-connect-webhook). The release file is `app-foss-release.apk`. Package name: `com.hcwebhook.app`. This ingest was checked against v1.9.22.
2. Grant every Health Connect permission the app requests, including background sync. Leave battery optimization as the phone already has it.
3. Set the sync interval to 15 minutes.
4. In ChatGPT, call `issue_health_connect_ingest_token` with consent `enable-health-connect-webhook`. The tool returns the `Authorization` value once. Issuing again replaces the previous token.
5. Add exactly one webhook URL, `https://whooplens.tech/api/health-connect/webhook`, with one custom header: name `Authorization`, value `Bearer` plus the token from that tool.

The server stores steps, sleep, heart rate, and exercise. Every other enabled type is counted and omitted so the app can advance its sync marker. Details are in [HC Webhook setup](docs/HC_WEBHOOK_SETUP.md).

WHOOP Stress Monitor history is not in the official WHOOP developer API. There is no measurement of low, medium, or high stress-zone duration, non-activity high stress, or a Stress Monitor timeline. Do not estimate those durations from cycle strain, average heart rate, HRV, resting heart rate, or workouts. If someone pastes their own Stress Trends summary, label it user-provided, keep it separate from synced WHOOP measurements, and do not store it.

## Existing Supabase connector

The Supabase function stays up. It is the working path for an existing WHOOP connection.

- Server URL: `https://evoiwauqplbcecumiwqn.supabase.co/functions/v1/whoop-mcp/mcp`
- Setup and consent: [https://astrasler.github.io/WHOOP-Lens/](https://astrasler.github.io/WHOOP-Lens/)
- Sign-in uses that person's Supabase user. WHOOP credentials are entered on WHOOP's authorization page.
- WHOOP refresh tokens stay in Supabase. They are not copied to Cloudflare.

### Connect WHOOP on the existing connector

1. Open [WHOOP Lens setup](https://astrasler.github.io/WHOOP-Lens/).
2. Enter the WHOOP Lens email and password, then click **Sign in securely**.
3. Under **WHOOP connection**, click **Connect WHOOP**.
4. On WHOOP's page, sign in with the WHOOP account and approve read access.
5. The setup page should then say **Your WHOOP account is connected.**

To add this existing connector in ChatGPT, use the Supabase server URL above, choose OAuth, and approve access with the same WHOOP Lens sign-in. A new WHOOP connection needs an open seat.

## Browser workspace

The Pages site includes a browser workspace at [https://astrasler.github.io/WHOOP-Lens/dashboard/](https://astrasler.github.io/WHOOP-Lens/dashboard/). It checks the Supabase sign-in and an existing WHOOP connection, then previews supported Health Connect v2 JSON and FHIR R4 bundles in the browser. Live health-file uploads stay disabled. The Android companion is an optional future bridge. See [Web workspace guide](docs/WEB_WORKSPACE.md).

## Capabilities

Connected clients can call **get_capabilities**. The deployed catalog is the source of truth. See [the capability directory](docs/CAPABILITIES.md).

## AI summaries (off)

WHOOP body-measurement, recovery, sleep, workout, and cycle reads, and stored Health Connect reads, can take an optional `summary: true` argument. The Worker then adds a `summary` object computed from that response only. `AI_SUMMARY_ENABLED` is `"false"` on the whoop-lens and resource Workers. The auth Worker does not declare it. Only the exact string `"true"` turns it on. While it is off, tool responses stay the same as they are today. A summary is not a diagnosis, not medical advice, and not a stress score. This does not add a derived stress estimate.

A summary object keeps this field order: `text`, `stats`, `model`, `generated_at`, `coverage`, `status`, `chart_data`, and `insights`. A template fallback also sets `fallback_reason` to `account_check_failed`, `quota`, `timeout`, `filter`, `injection`, or `model_error`. That same word is written to the log, with no secrets or measurements. `chart_data` has `date_range`, `record_count`, `series`, `sleep_recovery`, and `stress_estimate`. Each series is one allowlisted metric from that same response: `metric`, `name`, `unit`, `date_range`, `record_count`, `stats` (`min`, `max`, `mean`, `first`, `last`, `change`), `baseline`, `points`, `gaps`, and `gaps_truncated`. `points` are ordered by date. A day inside the series span with no sample is `{date, value: null}` and is also listed in `gaps`, so a chart does not draw across it. The data does not say whether that day was unworn or unsynced. Spans longer than 400 days set `gaps_truncated` and omit the filled days. `baseline` compares the latest point with the 30 UTC days before it: `window`, `days`, `sample_count`, `median`, `typical_range` (`low` and `high`, the 25th and 75th percentiles when at least four samples exist), and `complete`. When the read can page WHOOP history, those 30 days are fetched. When it cannot, `complete` is false and `days` is only the span actually present. `insights` are short factual sentences from those stats, including the baseline comparison when it exists. They describe the measurements. The template summary includes the same `chart_data` and `insights` when the model is not called.

`sleep_recovery` pairs a night's allowlisted sleep metrics with the recovery that names that sleep's `id` in `sleep_id`. WHOOP dates sleep by `start`, so a late evening in US Central Time can fall on the same UTC day as the morning recovery. Records with no id fall back to the next UTC day. `available` is false and `pairs` is empty when either side is missing. The sentences stay descriptive. Ids are not copied into the pair. `chart_data.stress_estimate` is `null` unless `STRESS_ESTIMATE_ENABLED` is exactly `"true"`. That flag is `"false"` on the whoop-lens and resource Workers. Setting it to `"true"` reserves an empty series with `available: false` and does not calculate a stress estimate. The Workers AI prompt still receives aggregates and selected evidence only, not the chart series, raw records, identifiers, or tokens.

`get_ai_usage` is listed only while `AI_SUMMARY_ENABLED` is exactly `"true"`. It returns the signed-in account's used, cap, and remaining neurons for the current UTC day. The global counter is added only when the verified user id equals `WHOOP_LENS_DEVELOPER_USER_ID`. The tool does not accept another user's id and does not return other accounts. `get_weekly_digest` is listed only while `WEEKLY_DIGEST_ENABLED` is exactly `"true"`. That flag is `"false"` on the whoop-lens and resource Workers. A ChatGPT scheduled task pulls the digest. WHOOP Lens does not send it, and no cron or schedule is configured. Call the tool with no other inputs. The optional `week_ending` argument is a `YYYY-MM-DD` date and is the last day of a seven-day window. When it is omitted, the window is the most recent complete Monday–Sunday week in UTC, ending on the previous Sunday. The response has `text`, `chart_data`, `insights`, and `status` (`model` or `template`) for that account's recovery and the prior night's sleep. Sleep is read from the day before the week as well, because a sleep can start the previous UTC day. The tool pages until that week is covered. The first complete, non-empty call for an account and week builds the digest. When summaries are also on, that call uses the same neuron quota and safety rules, and the week is cached only when `status` is `model`. A template fallback, including a full quota or a failed or stale analytics read, is returned and not cached, so a later call can try again. When summaries are off, the template is cached. A later call for a cached week returns that digest and does not spend more neurons. An empty week or a pull that stops before the week is covered is not cached, so a later call can try again. Migration `cloudflare/migrations/0011_ai_weekly_digest.sql` stores that cache. It is not applied to production by this change. A suggested ChatGPT scheduled task is: "Every Monday 8 AM, call WHOOP Lens get_weekly_digest and chart it."

The shared daily budget also counts Workers AI neurons used elsewhere on the same Cloudflare account. Before reserving a model call, the Worker reads today's UTC total (00:00 inclusive through the next midnight, exclusive) from the GraphQL Analytics API dataset `aiInferenceAdaptiveGroups`, summed as `totalNeurons`. The read uses the Worker secret `AI_ACCOUNT_ANALYTICS_TOKEN`, which needs only Account Analytics Read. The account id is `AI_ANALYTICS_ACCOUNT_ID`, a 32-character hex value supplied as a Wrangler var or secret when summaries are enabled. Neither value is committed. The room left for a call is the minimum of the per-user room (2,500), this Worker's global room (7,500), and 10,000 minus the account-wide total minus a 500 neuron safety margin. Migration `cloudflare/migrations/0010_ai_account_snapshot.sql` caches that total in D1 for 3 minutes. Reservations made after the snapshot are subtracted from the remaining room so analytics lag is not counted twice. `ANALYTICS_STALE_MS` is 10 minutes, measured from the fetch time or an explicit data-freshness watermark. The newest inference time is only the last counted call, so a quiet account whose last call was hours ago still gets a ceiling when the fetch is fresh. Local reservations made after that call are added to the analytics total. If the call time is missing, the ceiling uses the max of the analytics total and this Worker's local counter. A watermark older than 10 minutes, or a failed fetch, returns the template summary and does not call the model. If the analytics call fails, or a cached snapshot cannot be refreshed, the Worker also returns the template and does not call the model. `whoop-lens` and the resource Worker need the secret when the flag is turned on. The auth Worker does not. Migrations `0009_ai_usage.sql`, `0010_ai_account_snapshot.sql`, `0011_ai_weekly_digest.sql`, and `0012_ai_usage_event.sql` are not applied to production by this change.

WHOOP Lens reads profile, body measurements, recovery, sleep, workouts, and cycles. Charts and outside research depend on the connected AI host.

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

The consent and connection UI in `docs/` is the GitHub Pages site: [https://astrasler.github.io/WHOOP-Lens/](https://astrasler.github.io/WHOOP-Lens/). That site signs a person into the existing Supabase connector. This repository does not add a separate account system for that path.

WHOOP requests for the existing connector are handled by the Supabase edge function `whoop-mcp`. Its source is `supabase/functions/whoop-mcp/` (`index.ts` plus `handler.mjs` and `challenge.mjs`). Those files are the bytes that should be deployed. `supabase/whoop-mcp.SOURCE.sha256` is a checksum of them, and `node --test` fails if the files drift from that lock. Supabase processes those requests.

WHOOP access and refresh tokens for that connector are encrypted per Supabase user and stored in Supabase. They are not stored only in the browser. The Pages app keeps the Supabase sign-in session in memory for the open tab. Those tokens are not copied to Cloudflare.

Runtime secrets for the Supabase function stay in the Supabase function environment. Do not commit tokens, WHOOP credentials, or service keys. When OpenAI issues a domain-verification token, set `OPENAI_APPS_CHALLENGE` in that environment. A GET to `/.well-known/openai-apps-challenge` returns that value as plain text. If the variable is missing, the route returns 404.

`supabase/config.toml` sets `verify_jwt = false` for `whoop-mcp`. Leave it false. The function checks the Supabase user and the WHOOP OAuth state itself, and the WHOOP callback does not carry a gateway JWT.

The private connector is the Cloudflare Worker `whoop-lens` on `whooplens.tech`. Its issuer is the Worker `whoop-lens-auth` on `auth.whooplens.tech`. GitHub Workers Builds on `main` do not auto-run `npx wrangler deploy`. Cloudflare preview builds are off, so a push does not run `npx wrangler preview` or add a failed Workers Builds check. Where Wrangler settings are checked in, their activation flags stay off so a repository deploy cannot turn the live private MCP off.

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
