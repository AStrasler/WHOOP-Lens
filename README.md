# WHOOP Lens

Hosted ChatGPT and Codex plugin for reading a person's own WHOOP data. It can also read Samsung Health records that were uploaded for that same person. This is an independent project. It is not affiliated with WHOOP.

## How it is hosted

The consent and connection UI in `docs/` is the GitHub Pages site: [https://astrasler.github.io/WHOOP-Lens/](https://astrasler.github.io/WHOOP-Lens/). Each person signs in with their own Supabase user. This repository does not add a separate account system.

WHOOP requests are handled by the Supabase edge function `whoop-mcp`. Its source is `supabase/functions/whoop-mcp/` (`index.ts` plus `handler.mjs` and `challenge.mjs`). Those files are the bytes that should be deployed. `supabase/whoop-mcp.SOURCE.sha256` is a checksum of them, and `node --test` fails if the files drift from that lock. Supabase processes those requests. The integration does not run only on the visitor's computer.

WHOOP access and refresh tokens are encrypted per Supabase user and stored in Supabase. They are not stored only in the browser. The Pages app keeps the Supabase sign-in session in memory for the open tab.

Runtime secrets stay in the Supabase function environment. Do not commit tokens, WHOOP credentials, or service keys. When OpenAI issues a domain-verification token, set `OPENAI_APPS_CHALLENGE` in that environment. A GET to `/.well-known/openai-apps-challenge` returns that value as plain text. If the variable is missing, the route returns 404.

`supabase/config.toml` sets `verify_jwt = false` for `whoop-mcp`. Leave it false. The function checks the Supabase user and the WHOOP OAuth state itself, and the WHOOP callback does not carry a gateway JWT.

## Seats

A new WHOOP connection needs an open seat. There are 9 public seats and 1 developer seat. A person who already has a connection can reconnect and keep using MCP. A person without a connection cannot finish a new one when the matching seat is unavailable: `/connect`, `connect_whoop`, and the WHOOP callback all stop before storing tokens.

The developer seat is the Supabase Auth user id in the function environment variable `WHOOP_LENS_DEVELOPER_USER_ID`. It is not stored in git. If that variable is unset or is not a UUID, nobody gets the developer seat and only the 9 public seats exist. The designated user can connect while public seats are full, unless another connection already has `seat_role = developer`. Changing the variable does not move an existing developer row; clear or reconnect that row first. Until the designated user reconnects, an older connection stays `public` and counts as a public seat.

Someone past the public cap gets HTTP 403 with `code` `seat_full`. The callback sends the browser back to the Pages app with `waitlist=1` and does not exchange the WHOOP code. No WHOOP tokens are stored for that attempt.

## Waitlist

When public seats are full, the function stores one `whoop_waitlist` row for that Supabase user. The row can contain only:

- `user_id`
- `contact_email` (the Supabase account email, and only when it matches the normal address pattern)
- `destination`, which is always `whoop-lens@outlook.com`
- `created_at`

It does not contain WHOOP access tokens, refresh tokens, client secrets, authorization codes, or health data. Logs for this path do not contain those values or the email. This repository does not send the notice. Apply `supabase/migrations/20261004120000_whoop_connection_seats_and_waitlist.sql` before deploying the function, then read the table when you want to mail that destination yourself.

## Logging

The function writes one JSON object per metric through `console.log`. Fields are limited to the metric name, outcome, status, route, duration, tool name, seat kind, page count, and Supabase user id. Tokens, authorization headers, OAuth codes, refresh tokens, emails, and health payloads are not fields on that object.

## Tests

```bash
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs
```

GitHub Actions runs that command on every push and every pull request. The tests do not need a live WHOOP account or real secrets. They do not prove production isolation against two live WHOOP accounts; they prove the function filters by the signed-in Supabase user when the database and WHOOP client are faked.

## WHOOP access

Connecting WHOOP requests these read scopes: `read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`, plus `offline` so the function can refresh access. The plugin does not request write access to WHOOP.

## Samsung Health

`get_samsung_health` reads Samsung Health records stored for the signed-in Supabase user, including sleep, heart rate, activity, and related measurements. Those records are a separate source from WHOOP.

## Revocation

Revoke the integration in your WHOOP account settings to stop future WHOOP reads. Revocation does not delete information already returned to ChatGPT or Codex. Sign out of the Pages app to drop the in-memory Supabase session. A Supabase user can also be disabled with the optional `whoop_members` kill switch. A new WHOOP connection still needs an open seat, as described above.

See the [privacy statement](https://astrasler.github.io/WHOOP-Lens/privacy/) for how data is handled. The same text is in [Privacy.md](Privacy.md).

## Public listing

These are the public addresses for someone connecting the ChatGPT plugin:

- Website: https://astrasler.github.io/WHOOP-Lens/
- Privacy: https://astrasler.github.io/WHOOP-Lens/privacy/
- Terms: https://astrasler.github.io/WHOOP-Lens/terms/
- Support: https://astrasler.github.io/WHOOP-Lens/support/
