# WHOOP Lens browser-first workspace

**Primary interface:** The browser. Invited testers can open the Pages workspace on a phone, laptop, or tablet. No companion APK is required for that preview. The private MCP is `https://whooplens.tech/mcp`. The GitHub Pages setup page remains the sign-in and WHOOP connect flow for the existing Supabase connector.

## Entry points

- Existing account setup / WHOOP OAuth: https://astrasler.github.io/WHOOP-Lens/
- Web workspace after deployment: https://astrasler.github.io/WHOOP-Lens/dashboard/

The dashboard URL is **proposed** while this PR is in draft. It will not necessarily be accessible on the live GitHub Pages website until the branch is merged and the Pages site updates. A GitHub Pages HTML file is publicly fetchable; security comes from the **invite-only Supabase Auth gate and enforced per-user API authorization**, not a secret URL. Do not put tokens or health records into the public repository.

## Mandatory invite-only access preflight

The draft web workspace requires Supabase authentication and an existing WHOOP connection, **but the existing backend is not yet a strict owner-approved allowlist**: accounts without a whoop_members row currently default to active, and a legacy public-seat connection flow exists. Read-only audit on October 11 showed **2 connected accounts, only 1 explicitly active membership row, and 1 connected account without a membership row**. The designated developer-seat user has an explicitly active membership.

Before publishing this dashboard as an invite-only beta, the owner must approve which existing users remain authorized, register their memberships without disclosing personal data in git, and separately review/deploy a server-side membership-required gate for WHOOP connection and health-record access. Do not simply change missing memberships to denied in production without resolving the existing connected account. A frontend-only gate is not an authorization boundary. No membership or authentication changes were made during this pivot.

## What the web workspace can do

1. Verify an existing WHOOP Lens Supabase user and a connected WHOOP account. No registration or invitations are issued from the website.
2. Review a **locally selected JSON file** without uploading its contents or storing it in browser storage.
3. Validate and preview **WHOOP Lens Health Connect protocol-v2 JSON**, up to 100 supported rows per file and 500 KB, with step/sleep/heart-rate/exercise metadata.
4. Preview supported **FHIR R4 Bundle** entries: conditions, medication statements and allergies, with unsupported entries skipped. These are sensitive context records, **not diagnoses inferred by the app**.
5. Clear the preview and sign out; no token persistence and no automatic uploads.

A generic Android Health Connect export is **not** necessarily in WHOOP Lens v2 format. This page does not currently convert Samsung CSVs, Google Takeout or arbitrary JSON; no unsupported exports are silently mapped.

## Important Android limitation

Android Health Connect APIs cannot be accessed directly from a normal web page or PWA. That remains true even when the website is opened on a Galaxy phone. WHOOP Lens does not build or require an Android companion. Health Connect data enters only as a user-selected file. FHIR R4 bundles stay a local preview and are not stored as Health Connect measurements.

## Privacy and deployment gates

The GitHub Pages preview is read-only. The browser's WEB_HEALTH_UPLOADS_ENABLED flag remains **false** and the page does not upload. The Cloudflare source can store a Health Connect v2 file only after a verified WHOOP Lens bearer, the exact consent string, and `WEB_HEALTH_IMPORT_ENABLED=true`. Checked-in flags default to false; production runs with `WEB_HEALTH_IMPORT_ENABLED=true`, and migration `cloudflare/migrations/0006_health_import_consent.sql` is applied to production. Migration `cloudflare/migrations/0008_whoop_credential_revocations.sql` is not applied to production. Deletion is per account and records consent withdrawal. A WHOOP disconnect also blocks an in-flight callback from saving that account's credentials. Automatic phone sync is a separate path, described in `docs/HC_WEBHOOK_SETUP.md`.

No additional paid hosting services are introduced. Existing service quotas and GitHub Pages limits still apply; zero additional infrastructure cost is a design constraint, **not a guarantee of unlimited usage**.

## Optional Android bridge

Prior Android code remains in the `android/` directory and is not part of the current architecture. It is not required for WHOOP access, MCP, or Health Connect file import, and it cannot upload while its release gate is false.
