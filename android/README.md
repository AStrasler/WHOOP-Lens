# WHOOP Lens companion (private preview build)

The Android 14+ private companion uses stable Health Connect 1.1.0 with **compile SDK 36**. It has compiled successfully in GitHub Actions, but **it has not yet been tested on a real Android phone or approved for distribution**.

## What works in code

- Supabase email/password sign-in with a short-lived **in-memory only** access token; the WHOOP Lens status endpoint must confirm an existing connected user.
- Sign-out clears the in-memory session.
- Only a signed-in user may open the Health Connect permission chooser for steps, sleep, heart rate and exercise.
- Manual on-device preview for **yesterday's aggregate steps** (avoids summing overlapping raw step sources).
- Manual on-device preview of up to 50 sleep, heart-rate and exercise records per category from the last 24 hours, only for permissions currently granted.
- **No automatic reads, no uploads, no background sync, no service-role secrets.** Preview counts do not imply records are absent when permissions are missing.

## Build

JDK 17, Gradle 8.11.1, Android SDK 36, Android Gradle Plugin 8.9.2. GitHub Actions `.github/workflows/android-build.yml` runs `gradle -p android --no-daemon :app:assembleDebug` and confirms the debug APK exists. This is not a signed distribution build.

## Still blocked for private beta

The Health Connect v2 backend and owner-only database schema are **drafts**, not deployed. Do not add a production upload button until those are staged, tested, reviewed and approved. Complete session-expiry/race handling, longer-range source-labeled previews, explicit upload review, retry and deletion controls, correct Health Connect permission revocation UI, signed private builds, real-device testing and invite-only access validation.

**Keep the companion private.** Do not publish an APK, public account registration or automatic data sharing.
