# Direct BLE and release preparation: local verification

Date: 2026-10-24 (America/Chicago). Branch: `codex/android-direct-ble-release`.
Baseline: PR #85 head `e833d93d9e01c5fffad6ee8d7d9f377885984da5`, with its
exercise-cache fix; attribution commit `2034715c124d3b787e0ec5f352605732bd71da58`
is included once. The initial verification below preceded publication; PR #86
now contains this work. No production configuration, source fork or live health
record was modified.

## Automated/local results

| Verification | Result / evidence scope |
|---|---|
| Android `testDebugUnitTest` | 117 passed, 0 failures/errors/skips: 94 existing tests plus 23 BLE tests |
| Android `lintDebug` | 0 errors, 46 warnings; existing warning categories remain |
| Debug / minified release assembly | Successful; debug and unsigned release variants built locally |
| Separate BLE instrumentation APK | Built with `-PlensTestRunner=io.github.astrasler.whooplens.BleReviewInstrumentation`; default design runner remains available |
| API 36 emulator instrumentation | 10 synthetic native BLE renders at 100%/200% text; scan/select/stop controls; offline credits; actual Android Keystore encryption, independent read, wrong-account rejection and erasure passed |
| Separate-process persistence | Write/read instrumentation invocations in separate processes retained and decrypted the BLE snapshot; saved data is never restored as Live |
| Emulator update | Existing code-4 app updated in place to code 5 with same signing identity; app-private test file survived. No uninstall/data reset |
| Node/Worker/site/integration suite | 586 passed, 0 failures/skips; includes four new BLE/release privacy checks |
| Final affected Node privacy checks | 10 passed (`android-companion.test.mjs` and `android-ble.test.mjs`) |
| Python release gates | 9 passed: immutable source, exact tag/version/channel, increasing versionCode, certificate/package/debug-asset rejection |
| Workflow syntax | YAML structure, manual/default-false publication gates, protected-environment declaration, all three Bash run scripts and embedded Python syntax passed locally; no remote dispatch |
| APK verification | Package unchanged; version `0.3.0-beta.1`, code 5; signed release non-debuggable; both variants match established certificate; notices present, private files and test-fixture classes absent |
| Original MIT notice | Preserved byte-for-byte from pinned whoop4-ble LICENSE |
| Existing dependency notices | Resolved-coordinate/POM inventory recorded (58 coordinates); full Apache, Checker qualifiers MIT, Health Connect external protobuf BSD and existing font OFL notices packaged/accessibly credited |
| App Links | Apex and www returned HTTP 200 with a browser user agent; package/fingerprint match. Generic Python user agent received 403; no production setting changed |

All logs, APKs, checksum files, native fixture PNGs and dependency reports remain
local under ignored `repair-results/direct-ble/` and
`repair-results/ble-phase2-research/`. No raw device/health captures are used.
The Android build uses the existing isolated temporary build copy, not a new
clone. Full commands and hardware checklist: [DIRECT_BLE.md](DIRECT_BLE.md).

Initial validation exposed test-harness issues (format-sensitive source assertion,
case-sensitive heading assertion and Windows test-runner argument quoting).
They were corrected and rerun. No unresolved automated test failure remains.
Existing Android SDK XML tool-version warning and deprecated configuration calls
in the earlier design instrumentation are not new BLE failures.

## Signing and physical evidence limits

The local signed release uses the **existing Android Debug certificate/key**,
not a replacement signing identity. SHA-256:
`C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78`.
It matches the supplied previously tested `WHOOP-Lens-0.2.2-widgets-debug.apk`
and current App Links. An APK's release build type does not change its signing
identity. No private key or password is committed or included in APK assets.

No Samsung install or physical WHOOP BLE session was performed. Exact 4.0/5.0/MG
model/firmware support, standard broadcast availability, real HR/R-R reception,
Samsung permission/reconnect behavior, battery behavior and phone upgrade/OAuth
continuity remain owner-device gates. Synthetic UI/parser tests are not hardware
evidence. Proprietary data, scores and continuous background BLE are unsupported
by this first implementation.

## Release/publication gates

Proposed tag `android-v0.3.0-beta.1`; one signed universal APK named
`WHOOP-Lens-android-v0.3.0-beta.1.apk` plus its SHA-256 checksum. Experimental
must be a prerelease, never stable/latest. No tag/release/assets have been created
remotely. The original implementation commit `daaab643` passed all nine GitHub checks
on PR #86. Follow-up review fixes receive a separate CI run.

The repository is currently public, so no Obtainium authentication is required
for future public release assets. No visibility change was made. Repository
signing secrets are absent and protected `android-release` environment is not
configured. Exact setup and Obtainium instructions: [ANDROID_RELEASES.md](../ANDROID_RELEASES.md).

The branch push and PR creation were subsequently approved. Remaining actions:
approve installing the selected signed APK on the Samsung without resetting
data; complete real-strap checks; provision protected signing secrets/reviewers;
separately approve the first experimental publication and workflow activation.
Do not merge PR #84 or #85, activate uploads/deletion, or deploy infrastructure
as part of any of these steps without separate authorization.

## PR #86 review follow-up

Two confirmed P2 findings are repaired: account readiness now resets stale
candidates before resolving a connection selection, and packet/freshness updates
retain their view binding rather than rebuilding navigation. Regression coverage
checks the A-to-B account transition and native drawer/scroll/focus retention.

Local follow-up verification: 118 Android unit tests and 587 Node/Worker/site
tests passed; debug and test APK assembly succeeded; lint has 0 errors and 46
warnings. API 36 emulator instrumentation passed ten native fixtures at 100%/200%
text, retained navigation during updates, and Android Keystore/account-isolation
checks. No physical strap or Samsung verification is implied. Local APKs from
the initial validation are earlier candidates; no APK was published.
