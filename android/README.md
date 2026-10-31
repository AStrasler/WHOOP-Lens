# WHOOP Lens Android companion

Published beta: **0.6.0-beta.1** (versionCode 8). Current acceptance candidate: **0.6.0-beta.2** (versionCode 9) in PR #112. The owner has tested the existing glass design on a Galaxy S26 Ultra; changes in the new candidate still require their own device acceptance.

The companion provides native WHOOP and separately attributed Health Connect views, Keystore-encrypted sessions/cache, opt-in local background refresh, private widgets and experimental foreground Direct BLE. Current changes preserve the visual design and organize information throughout the app; detailed source context lives in Sources & Freshness. See [application-wide acceptance changes](../docs/android-beta2-acceptance.md).

## Explicit cloud synchronization

`ManualSync.ENABLE_UPLOADS=true` enables the reviewed client, not consent or production activation. The client requires an authenticated protocol-1 readiness response, selected currently permitted categories, a fresh bounded exact-record preview and explicit upload confirmation. Supported categories match the existing server v2 contract: daily steps, heart-rate samples, sleep sessions and exercise sessions. Other categories remain local. No caller-selected user ID is trusted.

Each action is manual. Dashboard refresh, WorkManager jobs and Direct BLE never upload. Stable keys make retries/corrections idempotent. Last sync comes from a separate server row committed atomically with the successful import, not a consent or token-grant timestamp. Pause revokes ingestion while retaining the cloud copy; withdrawal deletes only the signed-in account's cloud Health Connect copy and sync metadata. Neither deletes phone records or WHOOP data.

Life Schedule retrieval/defaults and confirmed updates are per-account. Missing/invalid values resolve to Unpredictable without writing. AI, observation and background work have no preference setter. The app distinguishes service activation, sign-in and connection failures instead of claiming that every unavailable response is a network problem.

Production activation is separate: reviewed migrations 0022 → 0023 → 0024 → 0025, resource code release preserving live configuration, and explicit flag enablement. Missing lifecycle/storage schema fails closed. See [exact activation gates](../cloudflare/docs/companion-beta2-activation.md). No activation or production migration is performed by an APK update.

## Build and acceptance

JDK 17, Gradle 8.11.1, SDK 36, minSdk 34, targetSdk 35 and existing dependencies/signing identity are preserved. CI runs Android unit tests/lint/debug build, unsigned release preparation, and API 34/36 instrumentation at 1440×3120 with logical density 560/640. Font/appearance component tests and every major app/detail destination are rendered with synthetic data; text/chart bounds and stable repeated screenshots are checked. Long screenshots are tiled without omitting scroll regions. Emulator evidence is not One UI/physical-device approval.

The unsigned candidate is not installable over the signed beta. Signing/publication uses the protected existing manual release workflow after explicit owner approval, verifies the established certificate/package/version and publishes the Obtainium-compatible APK/checksum as a prerelease. See [0.6.0-beta.2 release preparation](../docs/releases/0.6.0-beta.2.md). Update the existing app; never uninstall or clear data as a release step.

Older preview reports remain historical evidence in [the October 24 verification record](../docs/android-companion-pr-verification-20261024.md), [design implementation](../docs/android-design-implementation-20261024.md), and [Direct BLE verification](../docs/ble/VERIFICATION-20261024.md). They do not establish acceptance or activation of beta.2.
