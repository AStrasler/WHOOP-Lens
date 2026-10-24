# WHOOP Lens repair and verification — October 24, 2026

Local repairs are implemented. Final checks: **553/553 Node tests and 17/17 Android unit tests passed; Android lint and debug assembly passed.** No production deployment, preview upload, merge, credential rotation, health upload, or live data deletion was performed.

## Preservation and starting state

Workspace: `C:\Users\Aaron\OneDrive\Documents\ChatGPT\Whoop Lens`.
Branch and HEAD remained `fix/mcp-oauth-reliability`, `10abf69909c0bc36697416e93616d60e7b3b633b`. Remote: `https://github.com/AStrasler/WHOOP-Lens.git`.

There was substantial pre-existing uncommitted work. Modified at entry: Android build configuration, manifest, MainActivity, ManualSync, PrivateSession; consent HTML; site headers, builder, and tests. Untracked at entry: companion launcher/rationale/resources/tests, Gradle wrapper and distribution ZIP, private backups, connect page/styles, consent styles, two site utility scripts, and the MCP instructions text file. These were not discarded or staged.

**Preservation limitation:** a full recursive copy was made before source edits, but its sandbox temporary directory became inaccessible after the command completed. A durable full-tree copy was subsequently made at `backups/repair-preservation-20261024/`. Files touched by these repairs were reconstructed there to the inspected pre-edit source using HEAD and the source read at the start. Its `PRESERVATION-NOTE.txt` explains that it is not a byte-for-byte pre-edit filesystem image; new repair files and generated outputs may remain. The older sibling `Whoop Lens Review Snapshots/` and all original backups were retained. The older snapshot predates the newer deletion safeguards. No claim is made that the initial exact filesystem snapshot remains recoverable.

`repair-results/repair-only.patch` compares the reconstructed pre-edit sources to the repaired sources. It is a review aid, not a replacement for the preservation caveat.

## Actual repairs

Paths below are relative to the workspace above.

| Files | Change and reason |
|---|---|
| `docs/auth-client.mjs`, `docs/auth-client.test.mjs` | Retired the still-active local Supabase browser client, cleared the public endpoint/key compatibility exports, and pointed MCP at Cloudflare. Every legacy method fails closed with a fixed message and makes zero requests. Kept redirect validation coverage. |
| `docs/android-companion.test.mjs` | Replaced obsolete source assertions about a date picker, removed deletion method, and old exception with checks matching the existing reviewed sync/deletion controls. |
| `site/.well-known/assetlinks.json` | Added the exact package and supplied debug signing certificate. No APK file hash was substituted. |
| `site/android/oauth/callback.html` | Added a static, script-free fallback with no external assets or links. Flat HTML serves the exact callback path without a trailing-slash redirect carrying the code. |
| `site/build.mjs`, `site/build.test.mjs`, `site/http-smoke.mjs`, `site/_headers` | Added both files to the explicit publication list, created nested destination directories, added bounded generated-directory removal retries, and verified JSON, headers, fingerprint and safe fallback output. Added a repeatable HTTP smoke script for the two exact endpoint paths. Callback responses are no-store and no-referrer. |
| `site/package.json`, `site/package-lock.json` | Pinned current Wrangler 4.152.0 after reproducing an old-runtime compatibility-date failure, and added build/test/check/preview scripts. `npm run preview` builds before invoking Wrangler; the preview script was not executed because it uploads remotely. |
| `android/.../PrivateSession.kt`, `android/.../PrivateSessionTest.kt` | Preserved in-memory sessions and S256 PKCE. Made the protocol testable on the JVM with Java URI/Base64 and an injected synthetic transport/clock. Rejects callback credentials, ports, fragments, wrong paths/hosts/state/issuer, duplicate fields and empty codes. Validates token type, value type and lifetime. Tests exercise actual PKCE exchange, replay, expiry, cancellation and sign-out during exchange. |
| `android/.../MainActivity.kt` | Clears the received callback from the Activity Intent. Removed false assurances that a failed deletion proves nothing changed, or that disabled uploads prove no older server records exist. |
| `android/.../ManualSync.kt`, `android/.../ManualSyncTest.kt` | Preserved both existing deletion gates and strict deletion-count parsing. Kept `ENABLE_UPLOADS=false`. Added public and internal connection-provider assertions and boolean/overflow/array count rejection. Error messages no longer include raw exception text. |
| `cloudflare/test/provider/d1-real-issue-reports.test.mjs` | Fixed two obsolete Supabase identity fixtures. Current active membership requires `cloudflare_access`; the old fixtures caused four misleading rate-limit failures in local D1. No production membership logic was relaxed. |
| `cloudflare/test/provider/oauth-provider.test.mjs` | Added real resource-handler checks for unauthenticated App Links, agreement with the published JSON, and non-reflection/no-store callback behavior. |
| `.github/workflows/android-build.yml` | CI now runs unit tests and lint as well as debug assembly. |
| `.gitignore`, `android/.gitignore` | Excluded private backups, repair outputs and the downloaded Gradle distribution ZIP from accidental staging. Existing files remain on disk. |

The full Kotlin source directory for `android/.../` is `android/app/src/main/java/io/github/astrasler/whooplens/`; tests are under `android/app/src/test/java/io/github/astrasler/whooplens/`.

## Executed checks

All results below were reproduced locally. Commands use PowerShell from the workspace unless another directory is specified. Detailed output is in ignored `repair-results/`.

| Check and command | Result |
|---|---|
| Baseline: `node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs` | 77/79 passed; two stale Android source assertions failed. Both named browser-auth tests passed locally because this branch still contained active legacy auth. |
| Final: `node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs` | **553 passed, 0 failed, 0 skipped**. Includes site, browser auth, retired Edge Function regressions, Workers, real OAuth provider and local D1. `final-node.txt`. |
| `node --test site/build.test.mjs` | **5 passed**. Explicit allowlist, content policy, public links, signing certificate and static fallback. `site.txt`. |
| `node --test cloudflare/test/provider/d1-real-issue-reports.test.mjs` | **5 passed** after fixture repair. Tests migrations through 0019, actual local workerd D1 constraints, approved reports, identity isolation, replay/expiry and 0018 rollback with stored synthetic reports. `d1.txt`. |
| `node site/build.mjs` | Passed after stopping the local server that held the generated output directory open. |
| `cloudflare/node_modules/.bin/wrangler.cmd deploy --dry-run --config site/wrangler.jsonc` | Passed; assets-only bundle, no bindings; nothing uploaded. `site-dry-run.txt`. |
| `.../wrangler.cmd deploy --dry-run --config cloudflare/oauth/resource/wrangler.jsonc --outdir repair-results/resource-bundle` | Passed. Disabled flags remain disabled. `resource-dry-run.txt`. |
| `.../wrangler.cmd deploy --dry-run --config cloudflare/oauth/auth-server/wrangler.jsonc --outdir repair-results/issuer-bundle` | Passed. `issuer-dry-run.txt`. |
| Site directory: `npm run check`; `node_modules/.bin/wrangler.cmd dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8791`; then workspace: `node site/http-smoke.mjs` | Wrangler **4.152.0** built and dry-ran successfully, then served both endpoints at the configured **2026-10-11** compatibility date. HTTP smoke passed: exact paths, JSON/fingerprint, no redirect/reflection, callback no-store/no-referrer. Server stopped afterward. `site-current-dry-run.txt`, `site-http-final.txt`. |
| Isolated Android: `gradlew.bat -p C:\Users\Aaron\AppData\Local\Temp\whoop-lens-android-verification testDebugUnitTest lintDebug assembleDebug --offline --no-daemon --console=plain` | **17 tests passed**: ManualSync 9, PrivateSession 8. Build successful. Lint: **0 errors, 36 warnings** (35 SetTextI18n, 1 OldTargetApi). `android-final.txt`. |
| `apksigner.bat verify --print-certs <isolated-copy>\app\build\outputs\apk\debug\app-debug.apk` | Passed; certificate SHA-256 matches `C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78`. |
| `adb.exe devices` | No device connected. No device test, APK installation, sign-in or Health Connect operation was performed. |
| `git diff --check` | Passed; Git emits CRLF checkout notices, not whitespace errors. |
| Local history pattern inspection | 3,369 reachable objects, including 1,191 blobs, scanned for selected high-confidence private-key, GitHub, OpenAI, AWS and Supabase secret patterns: no matches. No `.env`, keystore or private-key paths found in reachable file history. Current source scan: 243 files, no matches. This is a limited pattern inspection, not proof that arbitrary secrets are absent. |

The Android JVM suite uses the real `org.json:json:20240303` test dependency. Missing/null/negative/string/fractional/boolean/overflow/array counts fail; integer zero and three succeed. Both deletion entry points prove the injected connection factory is never called while disabled. Upload fails at its gate before opening a connection.

Environment failures were distinguished from assertions: the first sandboxed Android command could not write a Gradle cache lock; the authorized isolated copy passed. The broad sandboxed Worker run could not start its local runtime; the authorized local run then exposed the obsolete D1 identities and passed after their repair. A site rebuild while Wrangler was watching `dist` failed with EBUSY; stopping that local server resolved it. No source directories or backups were deleted to resolve locks.

**Resolved runtime failure:** existing Cloudflare tooling remains pinned to Wrangler 4.115.0, whose local workerd rejected the site’s October compatibility date. A first diagnostic smoke run used a July command-line override. The new site-only dependency was then pinned to Wrangler 4.152.0, installed without lifecycle scripts, and the build/dry-run and HTTP smoke were repeated successfully at the unmodified 2026-10-11 configured date. No remote preview was created.

## Cloudflare build diagnosis and exact pending settings

Read-only API inspection confirmed the failed build `4560deab-6d03-4aac-b27f-d5d41e8ff74c` used `/`, no build command, and `npx wrangler preview` at commit `10abf699...`.

The main site Worker tag is `36e50b6a5eaf440794987fc5e4f25ab6`. Production trigger `8f61e10f-a3ea-437f-880a-a1e101d7c81e` already has `/site`, `node build.mjs`, `npx wrangler deploy`, and production branch `main`. Its separate `previews_base_config` incorrectly has `/` and an empty build command.

A second branch build object exists at tag `78e12bd6af3844a38930e2f10f4d2288`, trigger `bec73074-8e5d-43ce-a7e3-c02835820b7a`, branch `fix/mcp-oauth-reliability`. Its settings also use `/`, no build command, and `npx wrangler preview`. This is a branch-specific duplicate configuration, not an additional production deployment target to promote.

Prepared, **not applied**:

1. For the main site's **preview settings**, set root directory `/site`, build command `node build.mjs`, preview command `npx wrangler preview --config wrangler.jsonc`. Keep production branch `main` and production deploy command `npx wrangler deploy --config wrangler.jsonc`. The new site package and lockfile pin Wrangler. Preserve the existing build token, caching, path filters, variables and production settings.
2. For the existing branch-specific object, set root `/site`, build `node build.mjs`, command `npx wrangler preview --config wrangler.jsonc`; keep the branch restriction exactly `fix/mcp-oauth-reliability`. Never change this command to `deploy`. After a successful main-site preview setup, disable its redundant automatic build in the dashboard if it is no longer needed; do not delete it without approval.
3. Local API payload templates are in `repair-results/cloudflare-build-settings.pending.json`. They intentionally contain no tokens or account credentials. Updating build settings affects future builds; applying them is held for explicit owner approval because these are live automatic build/deployment controls.

Cloudflare's current documentation confirms root directories control command working directories, and preview builds run the build command before the preview command: [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).

## Focused system and PR review

The passing suite exercises OAuth consent cookies/state, PKCE, DCR, refresh grants, metadata/reconnect behavior, active membership, concurrent seat limits, account isolation, encrypted credentials/cursors, connection generations, bounded WHOOP pagination, 401/403/429 handling, request budgets, source hierarchy, import consent and transactional migration preservation. Source inspection confirmed WHOOP measurement retrieval uses GET and the WHOOP authorization scope list contains read scopes plus offline access. Token exchange/refresh POSTs are authentication operations. No WHOOP measurement-writing capability was added.

WHOOP remains authoritative in the source contract. Health Connect is labeled separately; tests reject fabricated completeness and cross-account cursor use. Internal Health Connect deletion remains a separate, consented server capability behind its existing feature gates; Android remains disabled. Legacy Supabase Edge Functions, migrations, tests, documentation and private recovery exports remain for staged retirement. They were not removed or invoked against production. The active issuer verifies a signed Cloudflare Access JWT and an explicit subject mapping plus active D1 membership.

PR #79 is open/draft, 2 files, and retires the client plus tests. Its patch removes much redirect coverage and changes the authorization-ID regex to exclude literal backslash/`s` rather than whitespace; it should not be copied blindly. PR #80 is open/draft, 1 file, and explicitly leaves obsolete tests for follow-up. Neither is merged. These local repairs retain useful redirect tests and cover fail-closed behavior independently.

PR #83 is open, conflicts with main, and now contains **19 commits / 71 files / +2,404 -300**, far beyond its Windows hashing title: Notion integration and migration 0019; diagnostic/reporting changes; discovery, consent and refresh changes; identity retirement; Android OAuth and App Links. Its head matches local HEAD. Do not merge it under the assumption that it only changes line endings. No local branch switch, merge, rebase, commit, push or PR edit was performed.

Read-only deployment records observed:

| Worker | Current version | Deployment ID |
|---|---|---|
| `whoop-lens` | `c75f917e-769a-4bf6-9080-dbb7a98174ec` | `6212fcc3-9491-4e6a-9925-b5c0b85ded15` |
| `whoop-lens-auth` | `5ff00a64-77de-466e-aa65-aeaaf17a7bd2` | `dff8fa45-6627-4f5e-84c2-6057cbccfff5` |
| `whoop-lens-site` | `6895b343-8fb2-4d82-b670-4a0b0bc93901` | `cb729402-655d-4034-9cf3-c35808044898` |

These records are not proof of an exact source-to-Git match. In particular, local resource and issuer Wrangler files disable features and are not complete production configuration. Deployment annotations describe manual binding restoration. Do not deploy those local files unchanged to repair only App Links.

## Remaining work, release order, and approval checkpoint

**Confirmed outstanding:** the four public HTTPS requests for apex/www App Links and callback still returned **404**. Issuer and protected-resource discovery returned **200 JSON**. Local App Links fixes need deployment. The main preview base settings and branch-specific settings remain broken until approved changes are applied. PR #83 has conflicts and misleading scope.

**Unverified:** real-device OAuth/App Links/Health Connect behavior, release signing certificate, exact live source parity, and remote preview behavior. No device was connected. Release signing is optional/environment-supplied in Gradle; no release certificate was supplied or invented. Add its verified fingerprint alongside the debug fingerprint before distributing a differently signed APK. In-memory Android tokens intentionally disappear after process death and are not a persistent refresh session; restart sign-in in that case.

**Release sequence after approval:**

1. Review a source-only patch/commit and resolve PR #83 against current main. Suggested commit groups: browser retirement/tests; site publication and build configuration; Android safety/OAuth/tests/CI plus corrected D1 fixtures. Exclude all backups, health exports, Gradle distribution ZIP and repair logs. Do not stage the entire mixed working tree.
2. Record the current live Worker settings/bindings and rollback version IDs above. Compare proposed resource code to the actual live version; preserve live flags, secrets-store bindings, services and existing data integrations. This reconciliation is required before publishing the apex App Links handler.
3. Apply the approved build settings, then create **one** isolated site preview and inspect it. Use `cd site; npm ci; npm run preview` only after preview-upload approval. Confirm no production route is promoted and no health bindings/secrets are attached to this static site.
4. After separate production approval, publish the static site to www and the narrowly reviewed resource-handler update to the apex hostname. The manifest uses the apex, so www publication alone cannot repair Android verification. No D1 schema change is required by this repair.
5. Smoke-test `https://whooplens.tech/.well-known/assetlinks.json`: 200, application/json, public HTTPS, no Access challenge/redirect, exact package and certificate. Verify www as well. Request the exact callback using a synthetic code: 200, no reflected code or redirect, no-store/no-referrer. Verify issuer/resource discovery, unauthenticated MCP denial and a small authorized read only if separately available and approved.
6. On a connected Android device, use `adb shell pm verify-app-links --re-verify io.github.astrasler.whooplens` and `adb shell pm get-app-links io.github.astrasler.whooplens`; then start a real app sign-in, verify callback/session, and retry after cancellation/process death. Do not use upload/deletion buttons to test real data. Keep `ManualSync.ENABLE_UPLOADS=false`.

Rollback: restore the recorded site version and the separately recorded resource version/settings if needed; revert build settings to their recorded values. Restoring the previous site/resource versions also restores the known missing App Links behavior. This repair does not alter D1 or health data, so it needs no data rollback. Avoid rolling back unrelated live feature/binding fixes.

**Approval is required before** applying live build controls, uploading a preview, deploying production code, merging PRs, rotating credentials, removing build objects/backups, or changing live user records. All authorized local implementation and verification above is complete. No credential exposure was confirmed by the limited inspection, so no rotation was attempted.
