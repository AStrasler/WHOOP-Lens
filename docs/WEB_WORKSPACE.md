# WHOOP Lens browser-first workspace

**Primary interface:** The browser. This is the preferred path for invited testers on a phone, laptop or tablet. No companion APK, installation, or separate hosting service is required. The existing WHOOP Lens Supabase backend and GitHub Pages setup page remain unchanged until the draft PR is reviewed and merged.

## Entry points

- Existing account setup / WHOOP OAuth: https://astrasler.github.io/WHOOP-Lens/
- Web workspace after deployment: https://astrasler.github.io/WHOOP-Lens/dashboard/

The dashboard URL is **proposed** while this PR is in draft. It will not necessarily be accessible on the live GitHub Pages website until the branch is merged and the Pages site updates. A GitHub Pages HTML file is publicly fetchable; security comes from the **invite-only Supabase Auth gate and enforced per-user API authorization**, not a secret URL. Do not put tokens or health records into the public repository.

## What the web workspace can do

1. Verify an existing WHOOP Lens Supabase user and a connected WHOOP account. No registration or invitations are issued from the website.
2. Review a **locally selected JSON file** without uploading its contents or storing it in browser storage.
3. Validate and preview **WHOOP Lens Health Connect protocol-v2 JSON**, up to 100 supported rows per file and 500 KB, with step/sleep/heart-rate/exercise metadata.
4. Preview supported **FHIR R4 Bundle** entries: conditions, medication statements and allergies, with unsupported entries skipped. These are sensitive context records, **not diagnoses inferred by the app**.
5. Clear the preview and sign out; no token persistence and no automatic uploads.

A generic Android Health Connect export is **not** necessarily in WHOOP Lens v2 format. This page does not currently convert Samsung CSVs, Google Takeout or arbitrary JSON; no unsupported exports are silently mapped.

## Important Android limitation

Android Health Connect APIs cannot be accessed directly from a normal web page or PWA. That remains true even when the website is opened on a Galaxy phone. To get Health Connect data into the web app, the user must supply a **supported exported file**, or use an optional, separately reviewed native bridge later. No bridge is required for ordinary WHOOP access or local FHIR preview.

## Privacy and deployment gates

The local preview is read-only. The browser's WEB_HEALTH_UPLOADS_ENABLED flag remains **false** and there is no active upload action. Backend ingestion and RLS code in draft PRs #9 and #11 has not been deployed. A future upload must explicitly show what will be sent, require separate confirmation, derive account ownership from server-side auth, and support deletion. Actual rollout needs owner approval, staging tests and verified migration.

No additional paid hosting services are introduced. Existing service quotas and GitHub Pages limits still apply; zero additional infrastructure cost is a design constraint, **not a guarantee of unlimited usage**.

## Optional Android bridge

Prior Android code is preserved in the `android/` directory for future direct Health Connect access. It is **not a prerequisite**, is not released and cannot upload while its release gate is false. Private web beta is the primary direction.
