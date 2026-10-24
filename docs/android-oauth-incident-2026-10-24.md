# Android OAuth investigation: 24 October 2026

## Finding and evidence

**Confirmed defect:** the deployed consent document's CSP `form-action` permits
Cloudflare Access and ChatGPT, but not the Android callback at
`https://whooplens.tech/android/oauth/callback`. Chrome applies this restriction
through a form submission's redirect chain. The identical localized policy was
reproduced in real headless Chrome with localhost-only endpoints and external DNS
blocked: identity-handoff simulation reaches the final redirect, which Chrome
blocks. Adding only the Android callback permits completion. ChatGPT succeeds
before and after; an unrelated host remains blocked.

**Probable explanation of the reported black page:** after the blocked redirect,
Chrome leaves the consent form visible even though its one-time consent handle
has been consumed. Submitting Continue again returns `Authorization unavailable`.
Both this browser sequence and the real provider's consumed-handle rejection are
covered. This is not a claim to have captured the Samsung browser's original
network trace, or to have ruled out every other cause of that generic response.

Read-only Cloudflare checks confirmed auth version
`5ff00a64-77de-466e-aa65-aeaaf17a7bd2` serving 100% of traffic. Downloaded code
contains the old CSP. OAuth server, consent and existing diagnostic flags are ON.
Persisted logs have invocation logging OFF and query redaction ON. Safe log
queries for 06:38-06:50 America/Chicago found `authorization_completed` at
06:43:53.721, 06:44:02.893 and 06:45:54.686, with no token-exchange events in the
window. Existing events do not attribute a client; these are supporting timeline
evidence, not proof that every event belongs to Android. Failures in the consent
GET/POST path were previously swallowed without a stage event, so historical
client-validation/consent failures cannot be reconstructed from absent logs.

Only two public HTTP GET checks were made: deployed OAuth discovery and public
assetlinks, both 200. Discovery matches Android's issuer, registration,
authorization and token endpoints, S256, mcp:read and offline_access. App Links
publish the installed debug signing fingerprint. No production registration,
authorization transaction, token exchange, grant read, revocation or data mutation
was performed. No credentials, codes, cookies or PKCE verifiers were saved in the
investigation artifacts.

## Exact failure location and sign-in trace

- Android `PrivateSession.authorizationUrl`: discover same-origin endpoints,
  register a public authorization-code/refresh client, create PKCE S256 and state,
  and durably save the pending attempt in encrypted storage before opening Chrome.
  The actual requested scope is `mcp:read offline_access`, not only `mcp:read`.
- Auth Worker `makeConsentFlow.authorize` GET: official provider validates client,
  exact redirect, response type, resource and PKCE; describe client; create encrypted
  browser-bound consent transaction; render `consentPage` with `noStoreHeaders`.
- POST: same-origin/CSRF and scope checks, consume consent once, create independent
  upstream state/cookie, redirect to the Access-protected upstream callback.
- `callback`: consume browser-bound upstream state, validate Access JWT and active
  D1 membership, then `completeAuthorization` creates the code and redirect.
- **Defect:** `cloudflare/oauth/consent.mjs`, `noStoreHeaders`, omitted the final
  Android App Link from `form-action`. Browser policy can stop navigation after
  successful server-side completion and before the app receives the callback.
- **Literal message:** `cloudflare/oauth/auth-server/src/consent-flow.mjs`,
  `oauthError`, returns `Authorization unavailable`; the authorize POST catch
  returns it when `approveConsent` rejects a consumed/expired/browser-unbound handle.
  GET client/redirect failures and callback failures can also reach this message.
- Android `completeSignIn`: exact HTTPS callback, singleton state/code, issuer,
  pending attempt age and generation; durable replay prevention; code exchange
  with original verifier/resource; atomic encrypted access/refresh pair save.
  Existing refresh and sign-out behavior is unchanged.

## Repair

Add only the exact Android callback URL to the existing CSP form-action list.
Keep default-src none, hashed styles, frame denial, base-uri none, referrer policy,
PKCE, browser binding, replay prevention, scopes, resource validation, membership
and token logic unchanged. No Android or App Link change is needed.

Add opt-in fixed-label consent diagnostics for parsing/client validation, consent
storage, origin/form validation, approval, upstream configuration/session/redirect,
and callback stages. Known SDK descriptions map to fixed reasons; arbitrary error
text, request URLs, client IDs, forms, cookies and credentials are never logged.
Existing diagnostic flags already enable capture in production; no setting change
is required. Expired/missing clients still fail closed; no registration validation
or lifetime is relaxed.

Repeated/concurrent DCR succeeds in real pinned-provider tests. The provider's
90-day DCR TTL is unrelated to the observed minutes-long interval. KV's documented
eventual consistency remains an architectural property; it was not established as
the incident cause and no speculative storage migration or retry scheme was added.

## Verification

From the development worktree:

```powershell
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs
# 582 passed, zero failures, zero skips; includes real local Chrome.

C:\Users\Aaron\AppData\Local\Temp\whoop-lens-android-design\gradlew.bat -p C:\Users\Aaron\AppData\Local\Temp\whoop-lens-android-design testDebugUnitTest --offline --rerun-tasks --no-daemon --console=plain
# 88 passed, zero failures. No Android source changed.

node cloudflare/node_modules/wrangler/bin/wrangler.js deploy --config cloudflare/oauth/auth-server/wrangler.jsonc --dry-run --outdir <absolute-local-artifact-directory>
# Passed; no upload/deployment. Artifact: repair-results/oauth-investigation/issuer-bundle-final/index.js

git diff --check
```

New coverage includes before/after Chrome redirects, repeated Continue after a
blocked return, preserved ChatGPT redirects, foreign-host rejection, fresh Android
DCR through PKCE exchange and refresh rotation, eight sequential/concurrent
registrations, expired/missing clients, invalid redirects/resources/PKCE, consumed
and expired consent, storage failures and credential-free failure classification.
Existing suites cover browser-cookie/state mismatch/replay, Access JWT/membership,
Android process restart/refresh/sign-out/isolation and ChatGPT compatibility.

The Chrome test uses a disposable local profile and mocked HTTP redirect servers;
it is not a live Access login or Samsung App Link launch. Browser CI can set
`WHOOP_TEST_CHROME` to an installed Chrome binary; without an available binary it
reports an explicit skip. No browser download or phone/emulator installation occurs.
A Windows startup file-lock race in the new harness was fixed. The full suite also
exposed an existing diagnostic test with yesterday's fixed timestamp on a real-clock
RPC path; only that test now generates a current timestamp. Production report logic
was not changed. Android lint/APK assembly was not rerun because Android is unchanged;
the existing v0.2.2 build remains the applicable installed artifact.

## Deployment, compatibility and rollback

**Approval required:** deploy the prepared code to `whoop-lens-auth` only. No push,
merge, release, resource Worker deployment, website deployment, Android rebuild or
new APK is needed. Existing ChatGPT refresh grants and active sessions retain their
SDK, storage format, issuer, resource, clients, bindings and token policy.

Use a code-only update of the existing Worker (for example its existing dashboard
code editor with the generated single-module index.js), preserving all current
bindings, variables, secrets, routes and observability settings. **Do not run the
checked-in Wrangler configuration as a production deployment:** its stage flags
are OFF and it omits existing production mail/diagnostic bindings. The dry-run was
only a local bundle build; its configuration must not replace production settings.
No D1 migration, KV migration, client re-registration, grant/token revocation, data
reset or membership change is required.

After explicit approval and deployment: start a fresh Sign In from the existing
Android v0.2.2 app; approve consent; verify return to the app, session establishment,
restart persistence and refresh. Repeat with a fresh attempt; do not re-submit an
old one-time consent form. Confirm a successful callback is followed by the
allowlisted authorization-code event and that existing ChatGPT MCP connections
still work without reconnecting. Verify revoked/missing permissions are unaffected.
This live/device smoke test is still pending; production is not claimed fixed.

Rollback only the auth Worker code to version
`5ff00a64-77de-466e-aa65-aeaaf17a7bd2` using the existing deployment/version controls,
keeping current settings and grants intact. No account reset or app data clearing.
Rollback restores the old Android CSP restriction; existing token sessions remain.

## Files changed

- `cloudflare/oauth/consent.mjs`
- `cloudflare/oauth/auth-server/src/consent-flow.mjs`
- `cloudflare/oauth/auth-server/src/oauth-diagnostics.mjs`
- `cloudflare/test/oauth-stage.test.mjs`
- `cloudflare/test/oauth-diagnostics.test.mjs`
- `cloudflare/test/provider/oauth-provider.test.mjs`
- `cloudflare/test/fixtures/oauth-browser-probe.mjs`
- `cloudflare/test/oauth-browser.test.mjs`
- `cloudflare/test/error-reports.test.mjs` (test-clock correction only)
- `docs/android-oauth-incident-2026-10-24.md`

References: [Chrome form-action redirect behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action),
[Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
