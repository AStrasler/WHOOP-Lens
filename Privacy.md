# WhoopLens — Privacy Statement

Last updated: October 20, 2026

WhoopLens is a private, read-only MCP that lets a person connect their own WHOOP account so ChatGPT and Codex can read that person's data with their permission. The project is operated by Aaron Strasler. It is not affiliated with WHOOP.

WhoopLens runs on Cloudflare. The MCP server is https://whooplens.tech/mcp and its authorization server is https://auth.whooplens.tech. Sign-in is a Cloudflare Access email one-time PIN. Access also requires an active WhoopLens membership granted by the owner; accounts are never created or linked automatically by email.

## Data accessed and purpose

With your authorization, the plugin reads WHOOP recovery, sleep, physiological cycles and strain, workouts, profile information, and body measurements. The WHOOP connection requests read scopes only (`read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`), plus `offline` so access can be refreshed.

If Samsung Health records are stored for your account in the WhoopLens Cloudflare D1 database, the plugin can also read those stored records, such as sleep, heart rate, blood oxygen, steps, activity, exercise, body composition, skin temperature, energy score, blood pressure, and profile. Samsung Health records are kept separate from WHOOP data, are read only for the signed-in account, and are not sold or used for advertising.

This information is used to answer your questions and produce the summaries you request in ChatGPT or Codex.

## Processing and sharing

The Cloudflare Workers handle sign-in, consent, the WHOOP authorization callback, WHOOP token refresh, and WHOOP API requests. WHOOP access and refresh tokens are not placed in the ChatGPT or Codex authorization grant.

Data returned to ChatGPT or Codex is processed by OpenAI under your OpenAI account settings and the OpenAI privacy policy: https://openai.com/policies/privacy-policy/.

WHOOP data is not sold and is not used for advertising. This privacy statement is published at https://astrasler.github.io/WHOOP-Lens/privacy/. WHOOP records, credentials, and access tokens are not published in the git repository.

## Credentials, retention, and revocation

WHOOP access and refresh tokens are encrypted with AES-256-GCM, bound to your account, and stored in a Cloudflare D1 database so the plugin can read WHOOP and refresh authorization. Pending WHOOP authorization requests are stored only as a hash and expire after 10 minutes.

Disconnecting WHOOP through WhoopLens deletes your stored WHOOP connection, pending authorization requests and any cached weekly AI digest. Disconnecting through WhoopLens requires an active membership. If your membership has ended, revoking in WHOOP stops future access but does not delete the stored connection; request that deletion privately by email to whoop-lens@outlook.com, as described on the support page. Do not request deletion in a public GitHub issue. You can also revoke the plugin in your WHOOP account settings. Revocation stops future authorized WHOOP access. It does not automatically delete information already included in ChatGPT or Codex conversations. Conversations remain subject to your OpenAI settings and controls.

WhoopLens has a limited number of connection seats, set by the owner and never more than 10, the owner's included. A person who does not already have a WHOOP connection cannot complete a new one when all seats are in use. Seats are granted only by the owner after a seat request; there is no self-registration. When seat requests are enabled, a request is emailed to whoop-lens@outlook.com and checked by Cloudflare Turnstile for abuse. Hashed request metadata is used for duplicate and abuse protection; form contents are not stored in the request database. The seat request form asks you not to include health information, passwords, or tokens, and it does not include WHOOP access tokens or health data from your account.

## Contact

For privacy questions, contact Aaron Strasler at the contact email specified in the WHOOP developer application.

## Changes

This statement will be updated if the plugin's data handling changes.

## Private Cloudflare MCP and optional processing

The private MCP at `whooplens.tech/mcp` verifies OAuth identity and active membership. Health Connect phone delivery requires a separate per-member ingest token and storage consent. Tokens are stored as hashes; each record is owned by the authenticated token's member. Revocation stops future writes, including uploads still in progress. Withdrawal deletes that member's Health Connect records and revokes ingest tokens.

On-demand summaries send minimized numerical facts and precomputed statements to Cloudflare Workers AI. Free-text record notes, credentials and account identifiers are excluded. WhoopLens stores daily usage counters and, when the weekly-digest feature is enabled, an account-scoped digest cache containing derived health facts and charts. It does not store model prompts. Disconnecting WHOOP through WhoopLens invalidates that account's weekly digests. Turning off AI or stress changes the reachable cache mode. Existing conversations remain subject to the host's retention controls.

Experimental stress estimates are WhoopLens calculations, not official WHOOP Stress Monitor measurements. They are not clinically validated. Feature activation does not grant access to another member or enroll anyone in cross-account analytics, except the owner-visible diagnostics and issue reports described below.

## Optional diagnostics and issue reports (owner-visible)

These features are off unless the server owner enables them. They are the one place where the server owner sees information about other members.

- **Diagnostic codes.** When diagnostic capture is enabled, WhoopLens records sanitized failure codes for every signed-in member, whether or not they submit a report: an error code, the affected area, a count and a time window, linked to the account. No health values, message text or tokens are stored. The server owner can see server-wide 24-hour counts, and on a small server may be able to tell which member a count came from. Codes are deleted after 30 days; cleanup runs on a daily schedule, so removal can lag by up to about a day.
- **Issue reports.** When issue reporting is enabled, a member can send a report with `report_issue` after previewing and approving the cleaned text. Cleaning is best-effort: it removes numbers, links, contact details and recognizable credentials, but a secret written in another form can be missed, and every other word, including any health or personal details the member writes, is stored and shown to the server owner as written. Leave health details, personal details and passwords out of a report. A report also attaches up to 10 of that member's recent diagnostic codes. The owner sees reports under a stable pseudonymous member reference, not an account id, and can change only a report's status.
- **Retention.** Unapproved previews expire after 10 minutes. Reports are kept until the owner resolves them, then deleted 180 days after their last update (cleanup runs on a daily schedule, so removal can lag by up to about a day).

## Optional flare journal (separate opt-in)

When the flare-journal feature is enabled, a member may separately consent to storing user-provided condition names, optional medication context, dated flare/non-flare/unknown labels, severity, symptoms, confounders and notes in account-scoped Cloudflare D1 tables. A second explicit consent permits on-demand descriptive comparison with that same member's WHOOP measurements. No diagnosis or label is inferred from conversation history, and membership or existing health consent grants neither purpose. Records persist until the member deletes them or withdraws journal consent. Analysis can be paused without deleting the journal; withdrawal deletes context and journal entries and revokes both purposes. A minimal consent state remains to enforce withdrawal.

The journal is not sent to Workers AI, used for training, shared across members, or included in developer analytics. Descriptive analyses are not persisted or cached. They do not produce validated flare predictions or notifications. User-requested journal reads and analyses appear in the user's chat and are then subject to the host's retention controls. Deleting the journal does not erase existing chat messages or separate WHOOP/Health Connect records.
