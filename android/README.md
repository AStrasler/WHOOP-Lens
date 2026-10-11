# WHOOP Lens Android companion (invite-only, unreleased)

**Status:** Debug APK compiled; not yet installed or tested on a phone. No production uploads, deletes, or migrations enabled.

## Implemented on the draft branch

- Android 14+ (minSdk 34, compileSdk 36) with Health Connect stable 1.1.0.
- Account sign-in via Supabase with an **in-memory** token. WHOOP Lens status must confirm an existing connection. Sign-out invalidates stale sign-in and preview callbacks.
- Explicit permission chooser. No background health reads.
- Manual local previews: yesterday's **aggregate** steps, plus up to 50 sleep, heart-rate and exercise records each in the last 24 hours. Counts are capped, not guaranteed to represent full totals.
- One-day aggregate steps prepared in a memory-only, five-minute-expiring snapshot. Separate Review control displays the date, count, mixed/unknown source origin, and destination. Actual Upload requires additional confirmation.
- User-selected date and second confirmation for deleting a previously imported steps record. This does not delete anything on the phone.

## Release gate remains OFF

ManualSync.ENABLE_UPLOADS is intentionally **false**. Both uploads and deletions remain disabled in the compiled APK until the production backend migration and private release are approved.

Protocol v2 sends schema_version 2, source health_connect, metric steps_daily, record_key daily:YYYY-MM-DD:local and the aggregate value and dates. No user ID is trusted from the phone. Server derives ownership from Supabase Auth. Stable keys permit correction without duplicate rows.

## Build / validation

JDK 17, Gradle 8.11.1, Android SDK 36, AGP 8.9.2. Private GitHub Actions compiles a debug APK and verifies the output. The PostgreSQL RLS test uses a disposable database, not production.

## Still needed

Real device installation and sign-in testing; verifying permission and revocation behavior; signed private package; approved backend deployment and end-to-end upload/deletion tests; token refresh and expiry recovery; complete paged non-step previews and source-attributed exports; rollout/rollback, quotas and privacy review.

Keep registration and distribution strictly owner-controlled. No public APK, automatic synchronization, or public registration.
