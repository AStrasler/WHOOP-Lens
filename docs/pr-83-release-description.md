# Securely persist Android sessions and prepare verified App Links release

Android sign-in now survives process restarts and same-signer updates using Keystore-encrypted, atomically stored OAuth credentials. The companion uses the existing Cloudflare refresh rotation and revocation endpoints, preserves PKCE/state protections, and keeps health uploads and deletion disabled.

Publish Digital Asset Links and a safe callback fallback on the apex resource and static site. Retire the legacy browser auth client without restoring Supabase sign-in. Fix obsolete fixtures, run Android unit tests/lint in CI, and provide a code-only resource release command that preserves all live Worker settings and refuses observed settings/version drift.

This branch reconciles current main with the former #83 head. Main already contains the Notion/reporting/OAuth reconciliation and binding safeguards; those are preserved rather than introduced again. The three merge conflicts are resolved. Supabase backups and data are untouched; no production migration is required.

Validation: 564 Node tests and 30 Android unit tests passed; Android lint has zero errors and 36 existing warnings; debug APK assembled and certificate verified. Site build, Worker dry runs and local exact-path HTTP checks passed. Provider tests cover refresh rotation, recovery after a lost response, revocation and inactive membership/account isolation. Keystore/reboot/update behavior still needs real-device verification.

No production deploy, remote preview, live setting change, merge or health-data write has been performed. Publishing this branch can trigger automatic previews; deployment approval is required. See `docs/release-checklist-20261024.md` for exact commands, build settings, version-pinned rollback and smoke tests. No OAuth issuer deployment is required for Android persistence.
