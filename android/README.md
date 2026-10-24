# WHOOP Lens Android companion (optional, unreleased)

> **Not required.** WHOOP Lens is now browser-first. This Android code is retained for an optional future Health Connect bridge. Users should not need to install an APK to access WHOOP Lens or review supported manual exports. See [browser workspace](../docs/WEB_WORKSPACE.md). Keep Android uploads and deletes disabled.

**Status:** Debug APK compiled; not yet installed or tested on a phone. No production uploads, deletes, or migrations enabled.

## Implemented on the draft branch

- Android 14+ (minSdk 34, compileSdk 36) with Health Connect stable 1.1.0.
- Cloudflare OAuth authorization-code + PKCE using the external browser, dynamic client registration and **Keystore-encrypted persistent access/refresh credentials**. Sessions survive process restarts, reboots after first unlock, and same-signer app updates. Refresh uses the existing Cloudflare OAuth flow with rotation; Cloudflare Access and D1 enforce membership. Sign-out invalidates stale sign-in and preview callbacks. Native redirect and token exchange require real-device verification before release.
- Explicit permission chooser. No background health reads.
- Manual local previews: yesterday's **aggregate** steps, plus up to 50 sleep, heart-rate and exercise records each in the last 24 hours. Counts are capped, not guaranteed to represent full totals.
- One-day aggregate steps prepared in a memory-only, five-minute-expiring snapshot. Separate Review control displays the date, count, mixed/unknown source origin, and destination. Actual Upload requires additional confirmation.
- Account deletion options distinguish local sign-out, Health Connect permissions and server data. Both upload and server deletion remain disabled; nothing deletes phone records.
- AES-256-GCM credentials use an Android Keystore key and an AtomicFile in noBackupFilesDir; cloud backup and device-transfer exclusions are explicit. One complete token pair is committed before use. Concurrent refreshes share one operation; sign-out/account changes reject stale completions.
- Access refresh runs on foreground resume and near expiry while the app is active; background requests obtain a fresh access token before use. Offline failures retain encrypted credentials and back off, while invalid/revoked refresh grants erase them. Sign-out erases locally immediately and attempts server grant revocation; an offline revocation is reported as unconfirmed.
- Pending PKCE/state is encrypted with a ten-minute lifetime and consumed durably before exchange. No tokens, codes or server error bodies are logged.

## Release gate remains OFF

ManualSync.ENABLE_UPLOADS is intentionally **false**. Both uploads and deletions remain disabled in the compiled APK until the production backend migration and private release are approved.

Protocol v2 sends schema_version 2, source health_connect, metric steps_daily, record_key daily:YYYY-MM-DD:local and the aggregate value and dates. No user ID is trusted from the phone. Server must derive ownership from Cloudflare OAuth and D1 membership. Stable keys permit correction without duplicate rows.

## Build / validation

JDK 17, Gradle 8.11.1, Android SDK 36, AGP 8.9.2. GitHub Actions runs Android unit tests, lint, and debug assembly. The PostgreSQL RLS test uses a disposable database, not production.

## Still needed

Real device installation and sign-in testing; verifying permission and revocation behavior; signed private package; approved backend deployment and end-to-end upload/deletion tests; Keystore/reboot/rotation/revocation verification on a real device; complete paged non-step previews and source-attributed exports; rollout/rollback, quotas and privacy review.

Keep registration and distribution strictly owner-controlled. No public APK, automatic synchronization, or public registration.
