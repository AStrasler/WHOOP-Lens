# Website sign-in for Life Schedule settings (#128)

**Decision:** the owner approved option 1 on Nov 1, 2026: a public browser OAuth client on `auth.whooplens.tech` using authorization code with S256 PKCE and the existing consent screen. Option 2 (a Cloudflare Access page) was not chosen.

## What a member sees
1. They open `https://whooplens.tech/settings/` and press **Sign in**.
2. They sign in on `auth.whooplens.tech` and approve access on the WhoopLens consent screen. This is the same screen ChatGPT and the Android app use. Only active members can approve.
3. Back on the page, they see their current Life Schedule (`fixed`, `flexible` or `unpredictable`; unset is shown as unpredictable).
4. They choose a value and press **Save**. Nothing changes without that click.
5. **Sign out** ends the session.

## Design
| Topic | Decision |
|---|---|
| Where the page lives | `https://whooplens.tech/settings/`, served by the resource Worker (`cloudflare/src/web-settings.mjs`). It is the same origin as `/v1/preferences/life-schedule`, so the API's existing same-origin check on writes applies unchanged and no CORS is added to the API. |
| Client | Public client `Ski8wTDIO6CqM746` ("WhoopLens website settings"), registered through the existing registration endpoint. It has no client secret, `token_endpoint_auth_method: none`, and exactly one redirect URI: `https://whooplens.tech/settings/`. |
| Flow | Authorization code + S256 PKCE, `scope=mcp:read`, `resource=https://whooplens.tech/mcp`. The verifier and state are 32 random bytes each, from `crypto.getRandomValues`. |
| Callback | Accepted only with exactly one `code` and a `state` equal to the one this tab stored. The query string is removed from the address bar and history before the code is exchanged. Errors and mismatches never reach the token endpoint. |
| Token storage | Page memory only. Never `localStorage`, cookies or the URL. Only the PKCE verifier and state are kept in `sessionStorage` across the sign-in redirect, and they are deleted as soon as the callback is read. A reload means signing in again. |
| Refresh | If the access token expires (401), one refresh is tried with the in-memory refresh token. A failed refresh signs the member out. |
| Sign-out and revocation | Sign-out revokes the grant at the token endpoint (RFC 7009) using the refresh token. Revoking it ends the whole grant. Leaving the page sends the same revocation with `keepalive`. If that cannot run (browser crash), the grant still expires after 30 days idle (`refreshTokenIdleTTL`). |
| Revoked or expired grant | The API returns 401 and the page shows "Your session ended. Sign in again." |
| CSRF / Origin | The page uses bearer tokens, not cookies, so a cross-site request cannot carry the member's credential. The API also rejects a PUT whose `Origin` is not `https://whooplens.tech`. Requests use `credentials: 'omit'`. |
| XSS hardening | CSP: `default-src 'none'`, a hash-pinned `script-src` and `style-src`, `connect-src 'self' https://auth.whooplens.tech`, `img-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`. Also `X-Frame-Options: DENY`, `no-referrer`, `nosniff`, `COOP same-origin` and `no-store`. There is no inline handler and no third-party script. Untrusted data is only ever set with `textContent`. |
| Member isolation | Identity comes only from the validated token (`ctx.props.userId`). The API keeps its active-membership fence and `selectLifeSchedule()` exact-keys check. |
| Values | Only `fixed`, `flexible` or `unpredictable`, enforced in the page and on the server. |
| Rate limits | The authorization server's existing limits apply to sign-in. The settings API is behind the same OAuth wrapper as the Android app. |
| Feature flag | With `LIFE_SCHEDULE_ENABLED` off, the page shows "not available" and contains no script. The API returns `feature_disabled`, which the page shows as "not available right now". |

## Tests
- `cloudflare/test/web-settings.test.mjs` (CI) covers:
  - the CSP hashes, which must match the served script and style;
  - security headers, the flag-off page and the method guard;
  - route order, with the page served before the OAuth gate;
  - S256 PKCE and exact authorize parameters;
  - callback state checks: mismatch, missing, duplicate and denied;
  - a full fake-browser run: code exchange, nothing persisted, 401 → one refresh → retry, exact PUT body, no save without a selection, and sign-out and page-leave revocation;
  - inactive member, feature disabled and session ended.
- `cloudflare/test/browser/settings-e2e.mjs` (manual, needs Playwright) runs the real page in Chromium with the CSP enforced, against intercepted endpoints.
- The existing Life Schedule suites cover the API: isolation, invalid values, flag off, missing schema, and cross-origin PUT rejected.

## Rollback
Remove the `/settings/` route and redeploy the previous Worker version. The registered client can stay; it is unusable without the page.
