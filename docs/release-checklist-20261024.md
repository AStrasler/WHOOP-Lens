# WHOOP Lens release candidate — October 24, 2026

The release candidate is prepared locally on `codex/release-candidate`. **No push, merge, preview upload, production deployment, credential rotation, or live health-data change has occurred.**

The original checkout remains at `C:\Users\Aaron\OneDrive\Documents\ChatGPT\Whoop Lens`. All **244** source files in the start-of-turn preservation manifest still match their SHA-256 hashes. The durable previous backup and current repairs exist. Essential legacy files are present; the supplied Supabase database/storage archives were not opened, restored, or needed. A read-only D1 membership aggregate returned three active members, all with Cloudflare identities and enabled Access mappings, and reported zero rows written. No health measurements were queried.

The isolated candidate checkout is:

`C:\Users\Aaron\OneDrive\Documents\ChatGPT\Whoop Lens\backups\release-candidate`

The subsequent review of every open PR and the complete companion is recorded in [PR and Android review](pr-and-android-review-20261024.md).

## Ready changes

- Legacy browser auth fails closed; its redirect checks and safe error behavior remain covered.
- Apex resource and www assets publish the Android Digital Asset Links JSON and exact callback fallback. The static builder explicitly publishes them; the callback does not redirect or reflect codes.
- Android sessions use AES-256-GCM with a non-exportable Android Keystore key and AtomicFile ciphertext in `noBackupFilesDir`. Backup/device-transfer exclusions are explicit. Same-package, same-signer updates preserve this storage; uninstall/clear-data, invalidated keys, revoked grants and server idle expiry require sign-in.
- Android requests `mcp:read offline_access` and registers both authorization-code and refresh grants. Persistent access requires the user to approve the stay-connected permission. Existing PKCE, exact callback validation, state and replay protections remain. Pending PKCE is encrypted for ten minutes and consumed durably before exchange, including across process restart.
- Refresh runs on foreground resume, at the next token refresh deadline while active, and before an authenticated background request obtains its access token. No periodic thread is started while signed out. One refresh runs at a time. Token pairs commit atomically before use; generation/account checks reject late work after sign-out/account changes. The pinned provider accepts the previous refresh token if a response is lost before the local commit. Transient failures back off without discarding encrypted credentials; invalid grants clear them.
- Sign-out erases local ciphertext and its key immediately, then attempts the advertised OAuth grant-revocation endpoint. If offline, local sign-out still succeeds and remote revocation is reported as unconfirmed; it cannot be guaranteed without a network connection.
- Android health uploads and deletion remain **disabled**. No automatic health reads, WHOOP measurement writes, or additional authentication service was introduced.
- Corrected obsolete Android/D1 fixtures, retained the main-branch rate-limit binding safeguards, and added code-only release tooling with settings/version drift checks.

**Cloudflare OAuth server changes required for persistent Android sessions: none.** The existing provider already supports public-client refresh rotation, recovery using the previous token, revocation and sliding 30-day idle refresh expiry. The issuer is deliberately not part of the required deployment. Resource membership and audience checks remain on every authenticated resource request; possession of cached local credentials is not server authorization.

## Verification evidence

| Local check | Result |
|---|---|
| `node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs` | **565 passed, 0 failed/skipped**. Includes five real local D1 tests, provider refresh/revocation, tenant isolation, seat controls, source attribution, pagination and four code-only release safety tests. |
| `gradlew.bat -p C:\Users\Aaron\AppData\Local\Temp\whoop-lens-android-review testDebugUnitTest lintDebug assembleDebug --offline --no-daemon --console=plain` | **38 unit tests passed**: 9 deletion/export, 9 OAuth protocol, 16 persistence/rotation/encryption and 4 companion control/lifecycle tests. Debug APK assembled. Lint **0 errors, 35 warnings** (34 UI text, 1 target SDK). |
| `npm run check` in `site/` | Build and Wrangler 4.152.0 deployment dry run passed. No upload. |
| `node site/http-smoke.mjs http://127.0.0.1:8793` with local Wrangler | Both exact endpoints passed at configured compatibility date **2026-10-11**, with JSON/fingerprint, no callback redirect/reflection, and no-store/no-referrer. Server stopped afterward. |
| Wrangler resource and issuer `deploy --dry-run` | Both bundle successfully; no upload. Their staging configs remain disabled and must not be used as normal production deploy configs. |
| `apksigner verify --print-certs` | Debug certificate matches the JSON fingerprint below. |
| `git diff --check` | Passed. |
| End-of-turn read-only Cloudflare inspection | Resource: **38 bindings**, issuer: **11**, site: **0**; all settings and deployed versions unchanged. |

Logs, snapshots, bundle hashes, pending build-setting payloads and the debug APK are in ignored `repair-results/` inside the candidate. No credential values are included in the release report. The older repair report is historical; its in-memory-session limitation is superseded here.

Persistence tests construct new session instances over real AES-GCM encrypted byte storage and simulate failures/concurrency. **They do not execute Android Keystore on a phone.** No device is connected. Reboot/update survival, native callback dispatch, hardware Keystore behavior and a real sign-in still require device verification. No production fix is claimed.

The merged checkout initially reproduced the known Windows byte-lock failure because files had been checked out before the branch's LF attributes applied. Checkout line endings were normalized to those attributes; no legacy Supabase authentication logic or data was restored or changed.

## PR #83 resolution

Current main already contains the Notion, reporting and OAuth reconciliation and production binding safeguards from #81/#82. The candidate merges main with #83 and resolves the three conflicts in `cloudflare/oauth/resource/src/index.mjs`, `cloudflare/test/error-reports.test.mjs`, and `cloudflare/test/notion.test.mjs` without discarding either side's intended behavior. The test conflicts were historical identity labels; the resource conflict retains the App Links/native routes and activation gate.

There is **no new diff against main** for Notion implementation, migration 0019, or the existing safe rate-limit helper. The remaining identity/client retirement and Android/App Links repairs are part of this release. Local source compared with the deployed resource has 32 identical shared module sections in a comparable build; the relocated capability JSON is identical. The intentional runtime differences are stricter Cloudflare identity predicates plus the App Links and native HTTP routes. Full binary equality is not claimed. The issuer has hand-patched deployment formatting and discovery/diagnostic differences; preserving the live issuer avoids an unnecessary replacement.

`docs/pr-83-release-description.md` contains the prepared replacement PR description. The candidate is a descendant of #83, so a normal, non-force push can update that PR. **Remote #83 still reports conflicts until the local candidate is published.** Publishing is held because branch pushes can trigger automatic preview deployments.

## Production-preserving deployment

Do **not** run ordinary `wrangler deploy` using `cloudflare/oauth/resource/wrangler.jsonc` or the issuer staging config. They contain disabled feature flags and omit live bindings, including Secrets Store references, the analytics credential, and seat-request email/Turnstile wiring.

Use `cloudflare/scripts/release-worker-content.mjs` for the resource. Its default is read-only. With `--apply`, it uses the supported API **PUT `/accounts/{account_id}/workers/scripts/whoop-lens/content`**, whose purpose is replacing code without touching configuration or metadata. It sends only `main_module` and the compiled module, rechecks the captured full settings/version immediately before upload, and verifies settings afterward. It refuses observed drift. No secret values are read or uploaded. A race after the last read is not an atomic API lock; stop and recapture if anyone else is changing production.

The required release leaves the issuer's refresh TTLs, OAuth KV, D1, Access audience/issuer, mailer and secrets untouched. It also preserves resource AI, AUTH_SERVER, D1, direct secrets, all seven Secrets Store references, Notion flags, import/webhook flags, reporting/diagnostic flags, member/developer request limits and query-string redaction. No D1 migration is required.

Prepare/review these commands from the candidate root (dry runs do not deploy):

```powershell
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location) 'repair-results\release-wrangler.log'
$env:WRANGLER_SEND_METRICS = 'false'
& .\cloudflare\node_modules\.bin\wrangler.cmd deploy --dry-run --config cloudflare/oauth/resource/wrangler.jsonc --outdir 'C:\Users\Aaron\OneDrive\Documents\ChatGPT\Whoop Lens\backups\release-candidate\repair-results\resource-bundle'
node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens --snapshot repair-results/live-worker-settings.json --bundle repair-results/resource-bundle/index.js --offline
```

The reviewed resource bundle SHA-256 is `9ef2845ca39d63f4aabcca9d6a9fc428eb16a3dd387d6422fdbda71e43d859aa` (rebuilding with different tooling can change it; review the newly printed hash before approval).

After explicit deployment approval, the exact resource command is:

```powershell
node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens --snapshot repair-results/live-worker-settings.json --bundle repair-results/resource-bundle/index.js --apply
```

It reads API credentials from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, never from source/arguments. The connected Cloudflare API can execute the same reviewed code-only request if shell credentials are unavailable; no new credential should be copied into this repository.

## Concise release checklist

1. **Ready:** local repairs, persistent Android sessions, regression coverage, debug APK, conflict resolution, code-only deployment script and PR description. Review the exact candidate diff and exclude `backups/`, `repair-results/`, uploaded archives and Gradle distribution ZIPs.
2. **Approved dashboard changes:** main site tag `36e50b6a5eaf440794987fc5e4f25ab6`, preview root `/site`, build `node build.mjs`, preview command `npx wrangler preview --config wrangler.jsonc`. Production stays branch `main`, root `/site`, build `node build.mjs`, deploy `npx wrangler deploy --config wrangler.jsonc`. Preserve build token/caching/path filters. For duplicate branch tag `78e12bd6af3844a38930e2f10f4d2288`, trigger `bec73074-8e5d-43ce-a7e3-c02835820b7a`, use the same root/build but keep command **preview** and the existing branch restriction. Do not promote development branches to production. Pending API payloads are saved but not applied.
3. **Remaining gates:** owner approval to publish the branch/trigger previews, change build settings, merge, and deploy; then real-device verification. A release signing fingerprint is still needed for any APK signed differently from the verified debug build. No essential source file is missing; no Supabase recovery is needed.
4. **Order:** approve/fix preview settings; publish the non-force candidate update to #83; inspect one isolated site preview; approve merge/production rollout (merging main can auto-deploy the site); publish www assets and the apex resource via the code-only command; leave the issuer alone; run smoke tests; install the debug APK only on an approved device and verify persistence. Site preview command after approval: `npm --prefix site run preview`. Production site command after approval: `site/node_modules/.bin/wrangler.cmd deploy --config site/wrangler.jsonc` after `npm --prefix site run build`.
5. **Rollback:** recorded resource version `c75f917e-769a-4bf6-9080-dbb7a98174ec`, site `6895b343-8fb2-4d82-b670-4a0b0bc93901`, issuer unchanged at `5ff00a64-77de-466e-aa65-aeaaf17a7bd2`. After approval, restore the resource/site versions through Cloudflare Deployments (or `wrangler rollback <version> --name <worker>`), confirm full settings/binding equality with the saved snapshot, then repeat smoke tests. Revert only build settings changed for this release if necessary. No data rollback or migration is involved. Rolling back restores the prior missing App Links behavior.
6. **Post-deployment smoke:** `node site/http-smoke.mjs https://www.whooplens.tech` and `node site/http-smoke.mjs https://whooplens.tech`; verify public HTTPS 200 JSON at `.well-known/assetlinks.json`, exact package and certificate, no Access challenge/redirect; callback 200/no-reflection/no-store/no-referrer; issuer and resource discovery 200; unauthenticated MCP 401. A controlled authenticated WHOOP read is optional only if separately available/approved; do not upload/delete health data.
7. **Device verification:** install the same-signer build; run `adb shell pm verify-app-links --re-verify io.github.astrasler.whooplens` and `adb shell pm get-app-links io.github.astrasler.whooplens`; complete sign-in with stay-connected permission; force-stop/reopen, reboot/unlock/reopen, and update in place. Verify automatic expiry refresh, sign-out/revocation and account switching. Keep `ManualSync.ENABLE_UPLOADS=false`. These are pending real-device tests, not reported successes.

**Fingerprint:** package `io.github.astrasler.whooplens`; debug signing certificate `C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78`. The newly built debug APK file SHA-256 is `B4A585FFB92F16B896D707C8A96EE81849454EB9A14655348C687E13C85716E1`; this file hash is **not** a signing certificate.

**Approval actions are explicit:** branch push that triggers previews; preview upload; live build-setting changes; PR merge (including its automatic site deployment); resource/site production deployment; rollback; device installation; and any live user-data operation. No live user-data operation is needed for this release.
