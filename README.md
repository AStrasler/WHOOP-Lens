# WHOOP Lens

Private, read-only MCP for a person's own WHOOP data. It can also read Samsung Health records that were uploaded for that same person. This is an independent project. It is not affiliated with WHOOP.

## Private connector

Use this connector in ChatGPT or Codex:

- Name: **WHOOP Lens**
- Server URL: `https://whooplens.tech/mcp`
- Authentication: OAuth
- Authorization server: `https://auth.whooplens.tech`
- Scope: `mcp:read`
- Protected resource metadata: `https://whooplens.tech/.well-known/oauth-protected-resource/mcp`

Sign-in is a Cloudflare Access email one-time PIN. The password form on the GitHub Pages site belongs to the existing Supabase connector.

The private server answers an unauthenticated request with an OAuth challenge. It does not return WHOOP measurements yet:

- The WHOOP client id and secret are saved on the Worker, and WHOOP connect is on.
- The WHOOP app must allow the redirect `https://whooplens.tech/api/whoop/callback`.
- The Cloudflare database has one membership and zero WHOOP connections. A connection is stored only after a separate WHOOP authorization.
- `https://whoop-lens.whoop-lens.workers.dev` is disabled.

A signed-in tool call still needs the owner to finish Access sign-in and complete that WHOOP authorization. WHOOP refresh tokens stay separate from the Supabase connector.

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

The private connector is the Cloudflare Worker `whoop-lens` on `whooplens.tech`. Its issuer is the Worker `whoop-lens-auth` on `auth.whooplens.tech`. GitHub Workers Builds on `main` do not auto-run `npx wrangler deploy`. Where Wrangler settings are checked in, their activation flags stay off so a repository deploy cannot turn the live private MCP off.

## Tests

```bash
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs
```

GitHub Actions runs that command on every push and every pull request. The tests do not need a live WHOOP account or real secrets. They do not prove production isolation against two live WHOOP accounts; they prove the function filters by the signed-in Supabase user when the database and WHOOP client are faked.

Where the Cloudflare sources are present, also run:

```bash
node --test cloudflare/test/mcp.test.mjs cloudflare/test/extra-tools.test.mjs
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
