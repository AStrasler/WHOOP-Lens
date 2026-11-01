# WHOOP connect browser binding

Status: implemented, **off by default** (`WHOOP_CONNECT_BROWSER_BINDING` is `"false"` in both committed Wrangler configs, like every other feature flag).

## Problem

`connect_whoop` used to return a WHOOP authorization link that worked for whoever opened it. If a member forwarded that link and the recipient approved it, the recipient's WHOOP account was saved under the member's WhoopLens account, and the member could then read the recipient's data through MCP. Exploiting this needs an invited member acting in bad faith, but members must not be able to read each other's data.

The Notion connection already binds its link to the browser that opens it. WHOOP did not.

## Behavior with the flag on

1. `connect_whoop` returns `https://whooplens.tech/api/whoop/start?state=…` instead of the WHOOP URL.
2. `GET /api/whoop/start` shows a confirmation page warning: *If someone sent you this link, do not continue.* It changes nothing, so link previews and scanners cannot use up the link.
3. **Continue to WHOOP** posts a same-origin form. The Worker stores the SHA-256 of a fresh browser nonce on the pending state (only once per state), sets the `__Host-wl_whoop` cookie (Secure, HttpOnly, SameSite=Lax, 10 minutes), and redirects with 303 to WHOOP using the same state.
4. `/api/whoop/callback` consumes the state only when the matching cookie is present. A request without the cookie, or with the wrong one, leaves the state unused and makes no call to WHOOP.
5. The callback shows a member-facing HTML result page instead of raw JSON, and clears the cookie.

Not changed: state expiry (10 minutes), the cap of 5 pending states per member, revocation fencing, seat limits, membership checks, token encryption, or the callback URL registered with WHOOP.

## What it does and does not stop

- **Stops:** a leaked state (from browser history, logs or a shared screenshot) after the member has confirmed it, completed from another browser; and link previews consuming the state.
- **Reduces, does not fully stop:** a member deliberately forwarding the start link. The recipient sees the warning, but if they still continue in their own browser, the cookie is set there. A complete fix would also require a signed-in WhoopLens identity on `whooplens.tech` (for example a Cloudflare Access application on `/api/whoop/start` whose identity must match the state's member). That needs a separate dashboard change and approval.

## Rollout

1. Apply migration `0026_whoop_oauth_browser_binding.sql` to the production D1 database. It only adds a nullable column, so it is safe while the flag is off.
2. Release the Worker code through the normal content-only release process (never plain `wrangler deploy`).
3. Set `WHOOP_CONNECT_BROWSER_BINDING=true` on the `whoop-lens` Worker using the safe settings procedure in [safe-worker-settings.md](safe-worker-settings.md).
4. Smoke test: run `connect_whoop`, confirm the link starts with `https://whooplens.tech/api/whoop/start`, open it, continue, approve in WHOOP and confirm the **WHOOP connected** page appears.

Rollback: set the flag back to `false`. Links issued while the flag was on stop working, so the member asks for a new one; existing connections are unaffected.

Tests: `cloudflare/test/whoop-start.test.mjs` (unit) and `cloudflare/test/whoop-start-browser.test.mjs` (real headless Chrome through the confirmation form, the WHOOP redirect and the callback; CI runs it with the runner's Chrome and fails if it can't).

## Incident: "Not allowed" on Continue to WHOOP (Nov 1, 2026)

Worker `77db9671` returned 403 "Not allowed. Please continue from the WhoopLens page." when a member clicked **Continue to WHOOP**. Production logs showed Chrome sent the form POST with `Origin: null` and `Sec-Fetch-Site: same-origin`. The confirmation page was served with `Referrer-Policy: no-referrer`, and browsers send `Origin: null` on form submissions from such documents. The start endpoint accepts only `https://whooplens.tech` or a missing Origin, so it rejected the request before reading the form. The state was in the POST body as intended; the URL showing no state was expected.

Fix: the confirmation page alone is served with `Referrer-Policy: same-origin` (the approach the OAuth consent page already uses). The strict Origin check is unchanged and `Origin: null` is still rejected. The state-bearing URL is still never sent to another origin; the browser test asserts WHOOP receives no referrer. No state was bound or consumed by the failed attempts, so no data needed repair.
