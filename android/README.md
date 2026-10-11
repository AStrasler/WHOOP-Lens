# WHOOP Lens companion (private beta scaffold)

This Android 14+ scaffold uses stable Health Connect client 1.1.0. **It does not read or upload any health records yet and is not ready for beta distribution.**

## Build requirements

- JDK 17, Android SDK API 36, and Gradle 8.11.1 (Android Gradle Plugin 8.9.2).
- `compileSdk = 36` is required by Health Connect 1.1.0. `minSdk = 34` retains Android 14+ support. Do not confuse compile SDK with the minimum version.
- GitHub Actions `.github/workflows/android-build.yml` installs the JDK and Gradle and attempts `:app:assembleDebug` on Android changes. The APK is a debug build only, **not a signed release**.

## Remaining functionality

Implement and test individual user sign-in, authorized Health Connect permissions, correctly aggregated daily steps, record preview, user-controlled upload to the version-2 ingestion endpoint, token/session handling, sign-out, user-directed record deletion, device tests, and a pinned verified Gradle wrapper. No service-role credentials or shared tokens belong in the app.

**Private access only.** No public distribution, background reads, or unattended upload is authorized by this scaffold.
