# WHOOP Lens Android design implementation — October 24, 2026

Development branch: **codex/android-approved-design**, based on released main **c77e2ce04a3160b3c8572212014e1301a085177c**. Local development only: no push, merge, deployment, personal-device installation, upload activation, production configuration change or live-data operation.

## Implementation

The supplied archive was inspected in full: 16 PNG artboards, all 16 PDF pages, and the HTML package including its nested artboard documents, Design System and Handoff. The archive remains unchanged. Its notes are design input, not additional authorization. Aaron's approved expansion to more Health Connect categories and background refresh supersedes its older four-category/manual-preview assumptions. The later subscription-free idea is on hold.

The native six-screen companion includes Home, Activity, Sleep, Vitals, Health Connect and Account & Settings; a 328dp modal drawer; metric details with 7/30/90-day views; drag/arrow card ordering and visibility preferences; permission explanations before Android's unchanged chooser; account/data dialogs; and signed-out, missing, loading, stale/offline, permission and read-error presentations.

Native components use the supplied premium-dark tokens, aqua accent, sand/dashed Health Connect labels, solid WHOOP labels, card radii, scaled typography and minimum 48dp controls. Inter and JetBrains Mono are bundled offline with SIL licenses. The pulse-ring mark replaces the old launcher artwork. Static visuals avoid sweeps/pulses and respect reduced-motion needs. At large font scale, paired cards and tab rows stack. Account/session controls remain separate from dashboard data.

OAuth PKCE, state, replay protection, App Links, encrypted credential persistence, refresh rotation and revocation remain in the existing implementation. The only protocol-class addition exposes an opaque local grant identity for cache ownership; it is not a server user ID or token. Sign-out/reconnect erases cached previews, cancels periodic work and resets future cloud consent and detailed widget exposure.

## Read-only data

**WHOOP:** the existing authenticated MCP endpoint and only get_recovery, get_sleep, get_cycles and get_workouts are used. No new server endpoint or OAuth issuer change is necessary. Tokens refresh through the existing session owner. Responses must identify authoritative WHOOP data; redirects, oversized bodies, server errors and changed-account completions fail closed. Server membership, scope, audience and ownership checks remain on every authenticated request. No caller-selected user ID is supplied.

History is capped at four pages per tool, passing opaque cursors unchanged and rejecting repeated cursors. Pending/unscored or missing fields remain absent. Recovery, strain, sleep, stage totals, HRV, resting HR, oxygen saturation, respiratory rate and absolute skin temperature retain WHOOP labels and timestamps. A chronological WHOOP sleep-stage timeline is unavailable from the current stage-total fields; no order is invented. A smallest compatible future change cannot manufacture data the upstream API does not expose.

**Health Connect:** 15 separately selected read categories: steps, sleep, heart rate, exercise, distance, active calories, floors, HRV/RMSSD, resting HR, oxygen saturation, respiration, body temperature, blood pressure, weight and body fat. No write, location or exercise-route permission is requested. Unsupported/ungranted or empty categories remain missing. Samsung Health is shown as the origin only if its actual package wrote the record.

Cumulative metrics use Health Connect aggregation and its source priorities, not summed raw steps. Raw reads cover up to 30 days, subject to Android's actual access window, with five pages of 200 recent records per type. Blank cursors terminate; repeated cursors fail closed; caps are marked partial. Known sleep intervals are unioned without double counting and never replaced by whole session duration. Record timestamps and writer packages are preserved. Body temperature is not relabelled as WHOOP skin temperature.

The cache is AES-GCM/Keystore encrypted in noBackupFilesDir under a separate key from OAuth, with atomic commits and account checks. Cached history is explicitly bounded to 500 samples per metric, 30 sleeps and 50 exercises; it is not a complete lifetime export. Partial WHOOP failures preserve dated previous values where possible. Corrupt or mismatched cache content does not appear under another account. Health Connect permission loss clears local Health Connect previews at the next permission check. App windows use FLAG_SECURE; native visual fixtures are rendered only by the separate test APK.

## Background refresh and synchronization

- Foreground dashboard refresh defaults on after permitted sign-in, with approximately five-minute local freshness and fifteen-minute WHOOP freshness checks. Manual refresh remains available.
- **Background dashboard refresh defaults off** and has an explicit explanation and opt-in. Unique WorkManager periodic work runs roughly every 30 minutes with a ten-minute flex window and battery-not-low constraint. No exact alarms, battery-exemption prompt, continuous sensors or foreground service is started.
- Background Health Connect access additionally requires its available platform feature and separately granted READ_HEALTH_DATA_IN_BACKGROUND permission. Unsupported devices retain foreground reads; denied background access does not disable permitted WHOOP reads.
- Work checks current grant identity, permissions, connectivity, stop/opt-out signals and account identity before publication. Offline jobs can refresh permitted local data without sending it anywhere. Permission loss, pause, sign-out and account changes invalidate/cancel work. Force-stop, Doze and Samsung sleeping-app policies can delay execution; no exact schedule is promised.
- Widgets consume saved encrypted cache; they never read Health Connect, refresh tokens or call the network themselves. Scheduled dashboard work and foreground changes refresh them. Source timestamps and stale state remain explicit.

**Cloud uploads and deletion are still OFF.** ManualSync.ENABLE_UPLOADS=false. The dashboard and worker have no upload or deletion call. Future cloud preparation is separate: category preferences, pause/reset controls, account-bound consent model, newest-revision deduplication and a gated sender abstraction are implemented and tested. Saving category choices explicitly does not grant transfer consent. There is no active cloud-upload worker, real sender, persistent upload queue or fabricated successful-sync status.

The inspected backend currently accepts the consent-bound Health Connect v2 file envelope, at most 100 records/512 KB, for steps_daily, sleep_session, heart_rate and exercise_session. It upserts by verified user, metric and record_key. The eleven additional local categories are not yet in that accepted schema. Before activation: agree on the supported categories (the smallest initial release can use those four), map stable SDK IDs to server record keys independently of a local login nonce, verify per-account idempotent retries and acknowledgement semantics, add an encrypted durable acknowledgement/change cursor, verify consent/withdrawal and real membership/account isolation against an approved environment, then obtain explicit transfer consent and release approval. Do not merely flip the compile-time gate.

## Widgets and Samsung support

Six resizable Android RemoteViews providers implement daily overview, recovery/strain, steps/activity, sleep summary, vitals and expanded dashboard. Compact and larger layouts use the same design palette, fonts, sources and freshness. Hidden/Summary is privacy-safe by default; Detailed home display requires an explicit public-display warning and measurement selection. Sign-out/account changes prevent previous-account values from being reused.

The six home widgets are the supported surface. A seventh status provider remains so an already placed receiver does not break, and it stays non-numeric, but it is a home-screen status widget. It does not register a Samsung lock-screen, Brief widget, or Now Bar integration. Issue #102 records why `widgetCategory="keyguard"` does not do that, and the current resources opt out with `not_keyguard` on API 36. A launcher may retain copied Detailed home content; the consent explains that limitation. Measurements are withheld while the device is locked. No watch app or proprietary Samsung service was added.

Platform references:
- [Android background Health Connect reads](https://developer.android.com/health-and-fitness/health-connect/read-data)
- [PeriodicWorkRequest scheduling limits](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest)
- [Android widget host categories](https://developer.android.com/reference/android/appwidget/AppWidgetProviderInfo)
- [Samsung's One UI 8 widget guide](https://www.samsung.com/uk/support/mobile-devices/one-ui-8-widgets-on-your-samsung-galaxy-s25/)

## Actual verification

- Full Node/Cloudflare/security regression command:
  node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs
  **565 passed, zero failed/skipped** on this development branch.
- Android:
  gradlew.bat -p C:/Users/Aaron/AppData/Local/Temp/whoop-lens-android-design testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest --offline --no-daemon --console=plain
  **73 unit tests passed**: 35 dashboard/data/sync/privacy/background tests plus the 38 existing OAuth, persistence, deletion and callback tests. Debug and separate test APKs built.
- Lint: **0 errors; 46 warnings**. Remaining categories: allocation-in-draw, dependency/target version advisories, older English string resources, View constructor and Kotlin-extension suggestions. No security assertion or failing check was disabled.
- API 36 local emulator: **22 native renders** (six screens, drawer, customization, detail, signed out, empty/error/offline/loading states, 200% text and seven widget layouts). The screenshots contain clearly labelled test-only fixtures; they are not real health data or a real login.
- Emulator exercised the actual Keystore/AtomicFile adapter across fresh storage instances and erasure; security level reported **0 (software)**. This is emulator evidence, not hardware-backed Samsung evidence. A stale-account WorkManager job completed without health/network reads.
- Signing certificate verified against the unchanged deployed App Links fingerprint. Git whitespace/conflict checks pass. Original source preservation and local bundle are recorded in ignored repair-results.

An early sandbox build needed runtime dependency downloads, one test-runner variable collision was fixed, and formatting required whitespace-tolerant source-wiring assertions. Native comparison exposed small-widget text clipping, which was corrected. Final checks refer to the final build, not those intermediate attempts.

## Visual comparison and remaining limits

Open the local [comparison gallery](../repair-results/design-comparison.html). PNG renders are in repair-results/verified-final. The test runner is only in src/androidTest and is absent from the companion APK.

The native palette, font families, card treatment, ring, source chips, navigation, range controls and chart gaps follow Claude's package. Differences are explicit:
- Android controls/dialogs replace HTML controls; touch targets and large-font reflow increase some heights.
- Expanded categories/background explanations add content to Health Connect and Settings.
- Health Connect series follow the design system's sand/dashed source convention even where an illustrative artboard used teal bars.
- Missing records, real absolute temperatures and incomplete stages replace illustrative numbers and timelines.
- The observed baseline band is mean ± standard deviation over at least 14 recorded days in the last 30, labelled as observed variation, not medical status.
- Native widget layouts favour readable typed measurements rather than duplicating every illustrative ring/tile arrangement. Exact launcher cell dimensions, scaling and lock-screen availability need Samsung testing.
- Ring sweeps, status pulses and drawer slides are static in this build. No perfect pixel match, TalkBack traversal or real One UI runtime result is claimed.

## APK and next actions

Verified APK: repair-results/WHOOP-Lens-design-dev.apk, version 0.2.0-dev (code 2), package io.github.astrasler.whooplens.
APK SHA-256: CF45BFA18193841423C15DC63AE91FC136A0C6920CEF2AA5DD4E61884661E6BA
Signer SHA-256: C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78.

With your participation, install this exact same-signer APK using adb install -r, or open it on Android 14+. A different signing certificate must not be handled by automatic uninstall. Verify native callback and live read-only WHOOP data; actual Samsung Keystore backing; restart/reboot/update persistence; foreground/background refresh and Samsung battery limits; permission revocation; offline recovery; sign-out/account switching; widget placement/privacy; large text and TalkBack. No phone was accessed. Do not activate uploads or deletion for these tests.

Local implementation is ready for device/design review. Physical-device behaviour, the cloud-upload activation work above and the listed visual/platform adaptations remain explicit limitations. Push/PR publication and any later merge/deployment remain unapproved.
