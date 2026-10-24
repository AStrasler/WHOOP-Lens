# Android screenshot fix — October 24, 2026

Branch: codex/android-approved-design. Original implementation ccaa118 remains preserved in Git and its existing APK/bundle. This is a targeted local change, with no push, merge, deployment, installation or new transfer.

## Cause and fix

MainActivity unconditionally added FLAG_SECURE during onCreate. Because all dashboard destinations and the drawer share that Activity, Android blocked screenshots, recordings and non-secure display capture throughout the companion. Source inspection found no Compose UI or other capture restrictions.

ScreenCapturePrivacy.kt now separates ordinary capture from recents previews:
- Normal content explicitly clears FLAG_SECURE.
- Credential/secret content can opt into FLAG_SECURE; the policy's protected branch remains tested.
- setRecentsScreenshotEnabled(false) keeps recents previews private independently. It is available since API 33; this app requires API 34 or newer.
- MainActivity reapplies normal policy on creation, resume and each render, so a secure flag cannot stick after returning to normal content.
- PermissionsRationaleActivity uses the same ordinary-capture/private-recents policy.

The current companion has no password, token, credential or secret-display screen. OAuth authorization runs in the external browser, and callback codes are not rendered in the app. No fabricated protected UI was added. Browser and Android permission-sheet capture policies remain owned by their respective applications/system. Widgets are RemoteViews hosted by the launcher; this app does not set their host window flags. Their existing privacy/redaction settings are unchanged.

Reference: [Android Activity.setRecentsScreenshotEnabled](https://developer.android.com/reference/android/app/Activity#setRecentsScreenshotEnabled(boolean)) explicitly distinguishes recents capture from user screenshots.

## Changed files

- android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt
- android/app/src/main/java/io/github/astrasler/whooplens/PermissionsRationaleActivity.kt
- android/app/src/main/java/io/github/astrasler/whooplens/ScreenCapturePrivacy.kt (new)
- android/app/src/test/java/io/github/astrasler/whooplens/ScreenCapturePrivacyTest.kt (new)
- android/app/build.gradle.kts: installable update version 0.2.1-dev, code 3
- docs/android-companion.test.mjs: policy wiring/security regression check
- This report

Secure storage, encrypted cache, OAuth, account isolation, access controls, background scheduling, upload gates and deletion guards are otherwise unchanged. ManualSync.ENABLE_UPLOADS=false. No background transfer is enabled.

## Verification

Android command:
gradlew.bat -p C:/Users/Aaron/AppData/Local/Temp/whoop-lens-android-design testDebugUnitTest lintDebug assembleDebug --offline --no-daemon --console=plain

**76 unit tests passed; lint 0 errors / 46 unchanged warnings; debug APK assembly passed.** Warnings: 6 allocation-in-draw, 3 dependency advisories, 1 target-SDK advisory, 3 string/localization, 15 unused resources, 15 Kotlin-extension suggestions and 3 View constructor suggestions.

Node command:
node --test docs/android-companion.test.mjs

**4 checks passed**. They cover the normal-screen policy's Activity/lifecycle wiring and retain the existing authentication, local-read, background-permission, storage/backup and disabled-write assertions.

Three new JVM tests exercise normal content, protected credential content, and repeated protected/unprotected transitions. Every case independently keeps recents capture disabled. There is no current secret-bearing app screen to exercise on-device; protection of that policy branch is simulated in the unit tests, not claimed as a device test.

No APK was installed, including on an emulator, because this assignment explicitly requires separate installation approval. Screenshots/recordings and recents behavior have not been exercised on the updated APK on a Samsung device. Verification is automated policy/wiring/build evidence plus the documented Android API behavior, not physical-device capture evidence.

## Updated APK

Full Windows path:
C:\Users\Aaron\OneDrive\Documents\ChatGPT\Whoop Lens\backups\android-design\repair-results\screenshot-fix\WHOOP-Lens-0.2.1-screenshots-debug.apk

APK SHA-256: F6C86BF533F511D264AB14806B273E2E6E12A1C548128EF8A7C42B377A7F3E78
Signer SHA-256: C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78.

The old 0.2.0 APK is retained separately. Same package and signing certificate allow an in-place update after approval; do not uninstall or clear data to test this fix.

## Samsung S26 Ultra follow-up

With your participation after installation approval:
1. Capture dashboard, drawer, Activity, Sleep, Vitals, metric details, Health Connect and Settings.
2. Use Samsung's screen recorder and confirm normal app content is visible in the recording.
3. Open Recents and confirm WHOOP Lens uses a blank/theme representation rather than a dashboard thumbnail.
4. Open the external sign-in browser and return/cancel; confirm normal companion screens still allow capture. Do not share browser screenshots containing authorization codes, credentials or secrets.
5. Check the existing home widget in Samsung's launcher; its host and device policies govern screenshot availability.
6. If capture is still blocked, distinguish the app window from browser/system restrictions and any Knox/work-profile/device policy. This change does not bypass device-admin policies.

Any OEM recents differences, actual Samsung recording behavior or system-level capture restrictions remain for real-device verification. No unrelated production or health-data action is required.
