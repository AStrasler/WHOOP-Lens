# WhoopLens repair backlog

The shared, repo-based chore list. Items are never dropped; resolved items stay with their evidence.
Started on Oct 25, 2026 at 11:00 AM CT. Members are anonymised as m1, m2, ... by sorted id. From the 11:30 AM update on, all queries rank against `whoop_members`, so m1–m3 are consistent across tables (m1 public seat, m2 developer seat, m3 public seat). "No recent events" is never treated as proof of resolution. No tokens, ids or health values appear here.

**Workflow:** Discover → Investigate → Repair → Test → Request Codex Review → Address Feedback → Verify → Request Owner Approval.

**Roles:** Codex is the technical lead and final technical reviewer. Grok investigates and prepares dev-branch fixes and tests. Aaron (owner) approves merges, deploys and production changes.

**Codex review states:**

| State | Meaning |
|---|---|
| `not requested` | No review has been asked for. |
| `requested` | A request was posted; Codex hasn't responded. |
| `pending` | Codex acknowledged but hasn't finished, or is rate-limited (Awaiting Codex Review). |
| `completed` | Codex finished a review. Its findings are listed with the item. |
| `approved` | Codex completed a review with no open findings. This still doesn't authorize a merge or deploy. |

**Evidence vs inference:** **E:** marks observed evidence, with its source. **I:** marks inference.

---

## Summary

**Current RB-016 retention state (Oct 27, 2026):** The live `whoop-lens` Worker has a daily Cloudflare cron trigger `17 9 * * *` (UTC). `scheduled()` calls `runRetention()`, which deletes diagnostic rows older than 30 days, resolved reports older than 180 days, and expired approvals, including when no member is active. Request-time cleanup in `capture()` and in issue-report preview, submission, and owner review remains the fallback. Historical investigation entries below record the Oct 25 pre-schedule state and should not be read as current production settings.

| ID | Severity | Item | Status | Codex | Owner approval needed |
|---|---|---|---|---|---|
| RB-001 | High | WHOOP refresh-token reuse under concurrent reads (PR #87) | Merged and deployed 10:34 AM CT. Natural refreshes seen for m2 at 11:31 AM, 12:32 PM and 1:33 PM CT (D1 `updated_at`/`expires_at` advanced by 1 h). No `whoop_refresh_*` failures or 401s since deploy. Only 3 samples, 1 member. **Not declared resolved** | completed, no major issues (6d57a83, c09ef87) | None now; keep monitoring |
| RB-002 | High | m3's WHOOP connection is unusable after the Oct 24 reuse incident | Still broken; no safe server-side recovery found. Related message fix under RB-014 | see RB-014 | Member reconnect (not forced); owner decides on outreach |
| RB-003 | Medium | m1's WHOOP access token expired since Oct 18; member inactive on WHOOP reads | Not a defect by itself; refresh state unknown until the next read. Reconnect message inaccuracy fixed under RB-014 | see RB-014 | Outreach decision (owner) |
| RB-004 | Low | AI summary `summary_fallback_filter` events | Cause open; diagnostic fix on `fix/diagnostic-reason-codes` (0f08223), PR pending | backlog P2 accepted; fix: not yet requested | Merge/deploy (owner) |
| RB-005 | Low | Health Connect `hc_only_unsupported_types` | Expected classification; tests added in PR #87 | completed (as part of #87) | None |
| RB-006 | Low | Notion: 1 of 2 accounts connected; one `notion_request_failed` | Likely unconnected, not a defect. Distinct Notion codes in the same diagnostic PR as RB-004 | not yet requested | Merge/deploy (owner) |
| RB-007 | Medium | Unauthorized WHOOP reads (401 diagnostics) | Explained by RB-001/RB-002; the classification works | completed (as part of #87) | None |
| RB-008 | Medium | Samsung/Android auth persistence: no physical-device verification | Unverified | n/a | Owner device run |
| RB-009 | Medium | Real second-account isolation: verified only synthetically | Unverified in production | n/a | Another member's explicit consent for a live test |
| RB-010 | Low | Test suite on Node 22.14 can't run `oauth-provider` (`registerHooks`) | Known environment issue; CI uses Node 24 | n/a | None |
| RB-011 | Low | Codex's OAuth suite count (123) vs Grok's (118) | Discrepancy, probably Node or OS version | n/a | None |
| RB-012 | Medium | Apex root, Previews config, external privacy/terms links, GitHub Pages, deletion promise | Deletion fix on `docs/private-deletion-requests` (dc71393); apex fix on `fix/apex-site-redirect` (8b6ece4); PRs pending. External links unverified | not yet requested (both) | Mailbox confirmation, merge, site and worker release, external settings |
| RB-013 | Low | Android test suite (38 tests) not reproducible on the Grok box (no JDK/Gradle) | Tooling gap | n/a | None |
| RB-014 | Medium | Rejected WHOOP refresh told members to "Retry shortly" although it's non-retryable | PR #92 (48d8349): CI 9/9 success, Codex completed with no findings. **Ready for release approval** | completed: no major issues (48d8349, 11:11 AM) | Merge + controlled release (owner) |
| RB-016 | Low | Retention deletions (30-day codes, 180-day reports) run only on member activity; no scheduled cleanup | PR #96 (f915111), draft. Production schedules: `[]` (read 12:44 PM CT). Exact schedule change below, **not applied** | e426abb completed clean; f915111 requested 12:45 PM | Owner: approve #96 release, then the separate schedule PUT |
| RB-017 | Medium | WHOOP disconnect deletes tokens locally but never revokes at WHOOP, and does not tell the member to remove the app in WHOOP | WHOOP documents `DELETE /developer/v2/user/access`. PR #98 (60fe118), draft: best-effort revoke behind `WHOOP_PROVIDER_REVOKE_ENABLED` (off), local deletion always proceeds, member instructions | requested 12:45 PM | Owner: approve PR, then whether to enable the flag |
| RB-018 | Low | Former members have no deletion path; process undocumented | Runbook PR #97 (037b2ad), draft. Fifth-pass check: runbook covers all 24 member-keyed tables in migrations 0001–0019, plus `OAUTH_KV` grants. No R2 bucket is bound | 037b2ad requested 12:15 PM; result pending | Owner: confirm private mailbox; approve runbook |
| RB-019 | Low | Notion network failures and real 503s share one code (`notion_unavailable`) | Assessed: not worth splitting now | n/a | None |
| RB-020 | Process | Several agents push to the same branches under the owner identity; provenance not recoverable from commits | Workflow documented in `CONTRIBUTING.md` (fifth pass) | n/a | Owner: confirm workflow |
| RB-021 | Low | A successful WHOOP refresh writes no diagnostic event, so refreshes can only be inferred from `whoop_connections.updated_at` | Fix on PR #99 (d94121a): one console line `{event:"whoop_refresh",outcome:"ok",rotated}` after the committed write; no ids, tokens, scope or expiry; no D1 write | completed, no major issues (d94121a) | Merge + release (owner) |
| RB-015 | Low | GitHub Pages duplicates the www site | Documented; recommendation below | n/a | Owner: keep or disable Pages |

---

## RB-001: WHOOP refresh-token reuse under concurrent reads
- **Severity:** High. A member's WHOOP connection was invalidated in production.
- **Reproduction evidence:**
  - **E (production D1 `diagnostic_events`):** m3 had four `whoop_unauthorized_*` reads at Oct 24, 22:00Z, then repeated `whoop_refresh_failed` events (4, 5 and 8 in the 02Z, 03Z and 04Z hours of Oct 25).
  - **E (synthetic, main b19c6a4 before #87):** 4 concurrent expired reads made 4 token requests. 10 reads × 2 members made 20. 3 separate instances made 10.
- **Root cause:** `whoopAccessToken` had no single-flight refresh, so concurrent reads each sent the same rotating refresh token.
- **Fix (PR #87, merged as 8887d4c):**
  - single-flight refresh per member within an isolate;
  - a cross-isolate D1 lease: a 120 s marker in `updated_at`, claimed by compare-and-set;
  - a 15 s holder deadline, which also bounds callers in the same isolate;
  - a bounded recovery after a failed takeover (`takeover-failed:` marker);
  - separate error codes: `whoop_refresh_rejected` vs `whoop_refresh_failed`.
- **Tests:** a 21-test concurrency file. It covers the 4- and 10-read bursts, two members, cross-instance contention on a file-backed SQLite, stale writes, 429s, API failures and valid-token reads. Backend on main after the merge: 496 pass, 1 skip, 0 fail. Provider: 23/23.
- **Grok findings:** the deterministic-clock correction fixed a test-only mixed-clock defect, not a runtime issue. The branch was merged with main (#88–#90) before release.
- **Codex:** reviews of 6d57a83 and c09ef87 completed with "no major issues". All P2 threads were addressed and resolved.
- **Deployment:**
  - **E (Cloudflare GET):** whoop-lens version `a2fd99ec` has been at 100% since Oct 25, 10:34 AM CT, with 38 bindings. The deployed code contains the `HOLDER_DEADLINE` and `takeover-failed` markers.
  - **Rollback:** `9a20fdcb`.
- **11:25 AM CT check:** 0 `whoop_refresh_*` and 0 `whoop_unauthorized_*` events since 15:34Z. m2's connection was last written at 15:30:11Z, before the deploy at 15:34:30Z. **No refresh has run on a2fd99ec yet.** Not validated: this needs at least one real refresh with no failure (m2 is due after 16:30Z on its next read).
- **Post-deploy verification (11:00 AM CT check, read-only D1):**
  - **E:** since 15:34Z (deploy): 0 `whoop_refresh_failed`, 0 `whoop_refresh_rejected`, 0 `whoop_unauthorized_*`. Only events: 3 `hc_delivery_stored` successes (one per member).
  - **E:** refresh successes are not instrumented as diagnostic events, so a success count isn't available from D1.
  - **I:** m2's stored expiry is 16:30:10Z, which implies its last refresh was about 15:30Z, before the deploy. So **no refresh has run on the new code yet**. Zero failures is not proof. Next check: after 16:30Z (11:30 AM CT), when m2's next read must refresh.
- **Outstanding objections:** none.

## RB-002: m3's WHOOP connection is unusable
- **Priority:** High. **Component:** WHOOP OAuth refresh. **Status:** still broken.
- **E (D1, metadata only):** expires_at Oct 24 23:32Z; scope includes `offline` and all 5 read scopes; a refresh token is stored (key version k2); no `lease:` or `takeover-failed:` marker.
- **E (D1 events):** 4 per-resource 401s at Oct 24 22:39Z, then 17 `whoop_refresh_failed` (last Oct 25 04:45Z). No WHOOP events since. m3 is still active on Health Connect (delivery at 15:52Z).
- **E (code):** those 17 were recorded by the pre-#87 build, which had one code for every refresh failure. So the stored telemetry **cannot** distinguish a WHOOP 400/401 rejection from a network or 5xx failure. The provider status is not stored.
- **I (likely root cause, not confirmed):** the RB-001 burst reused the rotating refresh token, and WHOOP invalidated it. Persistent failures over 2+ hours fit a rejection better than an outage, but that's inference.
- **Safe recovery check:** no code path can mint a token without a valid refresh token. A retry is attempted on every member read anyway; nothing else is safe. WHOOP's OAuth docs give a refresh-token grant only; an invalid refresh token requires re-authorization.
- **Confirming step (needs no approval, happens naturally):** m3's next read on a2fd99ec will record either `whoop_refresh_rejected` (confirmed) or `whoop_refresh_failed` (transient). We must not trigger it.
- **Repair:** none server-side. RB-014 makes the message tell the member to reconnect instead of "retry shortly".
- **Owner approval:** whether to contact m3 (not approved; not done). A draft message is in the 11:25 AM report.
- **E (code, relevant to the message):** reconnecting over an existing connection keeps the seat (`seatAvailableSql` allows an existing row). Disconnecting first frees the seat, and a reconnect could then fail if seats are full. So the member should **not** disconnect first.

## RB-003: m1's WHOOP connection expired since Oct 18
- **E (`whoop_connections`):** m1 is on a public seat. The connection expired on Oct 18, 23:38Z and has not been written since. There are no diagnostic events for m1 since Oct 23.
- **E (11:30 AM):** scope complete, refresh token stored, no markers, no failure events ever. m1 delivered Health Connect data at 15:34Z today, so the member is active, just not reading WHOOP.
- **E (code):** an expired access token is normal; the next read refreshes. Nothing runs on a schedule (no cron on any worker), so no inactivity job touches it.
- **I:** not a defect unless WHOOP has expired the refresh token. WHOOP doesn't document an inactivity expiry, so that's unknown until the next read.
- **Message accuracy (synthetic test):** a transient failure says "Retry shortly; if it keeps failing, reconnect WHOOP" (accurate). A rejected refresh token got the same "Retry shortly" text (inaccurate). Filed as RB-014 and fixed on a branch.
- **Status:** monitoring only. Outreach is the owner's decision.

## RB-004: AI summary fallbacks
- **E:** m2 had 16 `summary_fallback_filter` partial events, the last at Oct 25 03:45Z.
- **Correction (Codex P2 on #91, accepted):** the earlier "4 parallel calls" claim was wrong. `attachSummary` makes at most one model call (`runOnce`). And `filter` is also returned for an empty payload, an over-budget input, or malformed/duplicate/out-of-range selection JSON, not just output-grounding rejections.
- **E:** the `summary_filter` log line (rule name) isn't retrievable: a Workers Observability query for the last 3 days returned 0 events.
- **Status:** the fallback is safe; the **cause is open**. Distinguishing needs separate diagnostic codes per filter reason (proposed follow-up fix, not started).

## RB-005: Health Connect unsupported types
- **E:** m2 had `hc_only_unsupported_types` partial events on Oct 24. HC records arrive daily: 36 to 91 rows per day from Oct 18 to 25 (counts only).
- **Status:** the classification is correct, and tests were added in #87. Ingestion looks healthy.

## RB-006: Notion integration
- **E (D1):** m3 is connected (credentials, workspace, config). m2's row has no credentials, workspace or config, and was last written at Oct 24 00:43Z, the same minute as its one `notion_request_failed` (00:43:41Z).
- **E (code):** every `NotionError` other than 429 is recorded as `notion_request_failed`. That includes `connection_required` (409), `disabled`, `invalid_arguments` and `membership_required`. The status isn't stored. `createNotionAuthorization` creates the row without credentials; credentials are only written when the callback completes.
- **I (likely, unconfirmed):** m2 started a Notion connect or called a Notion tool without finishing the connect, and got `connection_required`. That's an intentionally unconnected account, not a defect.
- **Observation:** the diagnostic code lumps setup states with real request failures. A per-reason code would make this provable. Low priority.

## RB-007: Unauthorized WHOOP reads
- **E:** all 401 events in the window belong to m3 at the time of the RB-001 incident.
- **Status:** explained. The per-resource codes worked as designed (PR #75).

## RB-008: Samsung/Android auth
- **E (Codex report):** 38 Android unit tests pass (JVM simulations). No device was available, so it wasn't verified on a physical device.
- **Next:** the owner runs a check on the existing installed app at natural expiry. Grok doesn't touch Android files.

## RB-009: Second-account isolation
- **E:** the synthetic isolation tests pass (`member-isolation-e2e`, and two members in the concurrency tests).
- **Not verified live:** that needs another member's explicit authorization.

## RB-008: verification required
Owner, on the installed app: (1) leave the app signed in past a natural token expiry (> 1 h) and reopen it; (2) force-stop and reopen; (3) reboot the phone and reopen. Pass = no sign-in prompt and data loads each time. Record the date, app version and Android version. No code or release files are touched.

## RB-009: verification required
Needs another member's explicit written consent. Then, from the owner account: call each read tool and `review_issue_reports` and confirm that no member-2 data, ids or link handles appear; then repeat from member 2. Pass = zero cross-account rows. Until then, synthetic only.

## RB-010 – RB-011
Environment notes; see the summary table.

## RB-012: older open items
- **Apex:** `https://whooplens.tech/` returns 404 (no redirect). **E (Cloudflare GET):** the custom domains are `whooplens.tech` → whoop-lens (MCP), `www.whooplens.tech` → whoop-lens-site, and `auth.whooplens.tech` → whoop-lens-auth. **I:** the apex root has no handler. Whether it should redirect to www is an owner decision.
- **Live:** www `/`, `/privacy/`, `/terms/`, `/support/` return 200. `whooplens.tech/privacy` returns 404. `astrasler.github.io/WHOOP-Lens/` returns 200, but the GitHub Pages API returns 404, so Pages isn't configured on this repo through the API that's visible.
- **WHOOP dev app / ChatGPT links:** not readable by Grok. If either points at an apex path (`whooplens.tech/privacy`), it's a broken link. Owner to check.
- **Previews config on whoop-lens-site:** not changed. A Preview build ran on #91 (bot comment).
- **Deletion promise:** **E:** privacy says that after a membership ends, deleting the stored connection must be requested "through the support page". The support page only offers a **public** GitHub issue and gives no deletion instructions. **I:** a member would have to identify themselves publicly to request deletion. That's a confirmed content gap. The code has member-side deletion for WHOOP disconnect, HC withdrawal and Notion disconnect, but there's no path once membership has ended. Fix needs owner wording (for example, a private contact) and a site deploy.

## RB-012 update (11:25 AM CT)
- **Deletion (E: code vs pages):**
  - WHOOP disconnect deletes the connection, pending OAuth states and the cached weekly AI digest (the digest wasn't mentioned in privacy). It also records a revocation stamp.
  - Health Connect withdrawal deletes HC records and revokes ingest tokens.
  - Notion disconnect deletes credentials and settings.
  - Journal withdrawal deletes context and journal.
  - All of these need an active membership. Nothing deletes data for a former member.
  - Privacy said to use the support page; support only offered public GitHub issues.
- **Existing private channel (E):** `whoop-lens@outlook.com` is already published in the privacy statement and README for seat requests. It's the only private channel in the repo. No contact form or deletion endpoint exists.
- **Repair (`docs/private-deletion-requests`, dc71393):**
  - The support page gets a "Private requests and data deletion" section using that existing mailbox, listing the in-app deletion paths and the former-member path.
  - Privacy (HTML and `Privacy.md`) points to the mailbox and adds the digest.
  - A test checks the two pages agree.
  - **The owner must confirm** this mailbox may be used for deletion requests before merging.
  - **Residual:** handling a former member's deletion is a manual owner action (a D1 delete). No tool exists for it, so a runbook is needed.
- **Apex (E):** `whooplens.tech` is a custom domain of the whoop-lens worker. `/`, `/privacy`, `/terms` and `/support` returned 404 with an empty body (the OAuth resource wrapper's default). `/mcp` returns 401 with a `resource_metadata` challenge, and `/.well-known/oauth-protected-resource/mcp` returns 200.
- **Apex repair (`fix/apex-site-redirect`, 8b6ece4):** GET/HEAD on exactly those 7 paths returns 301 to `https://www.whooplens.tech/...`. Unit tests show `/mcp`, `/.well-known/*`, `/api/whoop/callback`, `/v1/*`, POST `/` and look-alike paths are not redirected. Needs a whoop-lens release; no DNS or route change.
- **External URLs to configure (unverified; Grok can't read those consoles):**
  - Privacy: `https://www.whooplens.tech/privacy/`
  - Terms: `https://www.whooplens.tech/terms/`
  - Support: `https://www.whooplens.tech/support/`
  - All three return 200 live. The apex forms return 404 until the redirect ships.

## RB-015: GitHub Pages
- **E:** the repo has `has_pages: true`, and its homepage is `https://astrasler.github.io/WHOOP-Lens/`. It's served by GitHub.com and was last modified 15:34Z today, rebuilt from `docs/` on the merge to main. The privacy, terms and support pages exist there too; the content differs from www only by the path prefix. The `/pages` API needs auth (it returns 404 unauthenticated). Neither copy has a canonical link.
- **I:** it's a second public copy of the same pages. It isn't harmful today, but it can drift, and the repo homepage points to it rather than www.
- **Recommendation (owner decision):** either disable Pages and set the repo homepage to `https://www.whooplens.tech/`, or keep it and add `rel=canonical` to www. Not changed.

## RB-013
The Android suite can't run on the Grok box. Verification requirement: a CI job or the owner runs `./gradlew test` and reports the count (expected 38).

## RB-014: rejected refresh told members to retry
- **Priority:** Medium. **Component:** MCP error messages (`cloudflare/src/mcp.mjs`).
- **E (code):** `whoop_refresh_rejected` is classified non-retryable (`incomplete_setup`), but the member text was "Retry shortly; if it keeps failing, reconnect WHOOP".
- **Repair:** rejected refreshes get "WHOOP no longer accepts the saved authorization, so retrying will not help; reconnect WHOOP in WhoopLens to continue." Transient refresh failures keep the retry text. No tokens or provider body appear in the message. Nothing reconnects or disconnects anything.
- **Tests (Node 22.23.4):** `cloudflare/test/*.test.mjs` 496 pass, 1 skip, 0 fail; provider 23/23; docs and supabase 77/77; site 6/6. CI not run yet (no PR yet).
- **PR:** #92. **Codex:** completed at 11:11 AM CT on 48d8349: "Didn't find any major issues". No inline findings.
- **CI (48d8349, per check):** www-site ×2, auth-controls ×2, stage-safety ×2 (runs the full `cloudflare/test`), oauth-dry-run ×2, and Workers Builds: whoop-lens-site. 9/9 success; none pending or skipped.
- **Status:** ready for owner release approval. Not merged or deployed.
- **Controlled release procedure (owner-approved only):**
  1. After merge, check out the merge commit.
  2. Bundle: `cloudflare/node_modules/.bin/wrangler deploy --dry-run --config cloudflare/oauth/resource/wrangler.jsonc --outdir <dir>`.
  3. Snapshot `whoop-lens` `/settings` and `/deployments` via GET.
  4. Run `node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens --snapshot <snap> --bundle <dir>/index.js` as a dry run (pass the bundled file that `wrangler deploy --dry-run --outdir <dir>` writes, not the directory; see `docs/release-checklist-20261024.md`). Expect `settingsIdentity` unchanged and `bindingCount 38`.
  5. Rollback (Cloudflare Deployments or `wrangler rollback <version-id> --name whoop-lens`, not the release script; then confirm settings equal the snapshot) = the live version at release time; at 11:25 AM CT that's `a2fd99ec-a4d8-4bb3-8425-2d64fc81c800` (100%; 38 bindings by GET). Re-read it immediately before release.
  6. Run `--apply` only with explicit owner approval. Never plain `wrangler deploy`.
- **Risks:** text only. ChatGPT may paraphrase.

---

## Third pass (Oct 25, about 11:50 AM CT)

**RB-001 evidence (metadata only).** m2's connection row was rewritten at 16:31:15Z (11:31 AM CT), with a new expiry one hour later (17:31:15Z). m2's connection generation is unchanged since Oct 20, so this was not a reconnect: it was a real refresh exchange on the #87 build (live since 15:34Z), and it succeeded. No refresh failure events have been logged since 15:34Z. This is one successful refresh, not proof under concurrency; keep monitoring. m1 and m3 rows are unchanged.

**RB-016: retention is opportunistic.** Evidence: no Worker has a cron trigger. `diagnostics.mjs` runs `SWEEP` and `retentionStatements` (report and approval purges) only inside the capture path, once per new bucket row, or every interval while capture is off. With little traffic, rows can outlive 30 or 180 days. Today no diagnostic row is older than 30 days (the oldest is from Oct 19). At this Oct 25 snapshot, PR #93 described request-time cleanup. The daily schedule in the current RB-016 status superseded that description.

**Former-member deletion is manual.** There is no tool for it. PR #93 now says the owner handles these requests by hand, with no fixed response time.

**PR #94 routing (read-only).** The custom domains are: apex to `whoop-lens`, www to `whoop-lens-site`, auth to `whoop-lens-auth`. There are no zone Worker routes and no page rules, and only managed rulesets. The redirect target is always www, which is served by a different Worker, so it cannot loop. The query string is now preserved.

## Fourth pass (Oct 25, about 12:10 PM CT)

**RB-016 trigger paths (code).** `capture()` in `cloudflare/src/diagnostics.mjs` runs `SWEEP` (diagnostic_events older than 30 days, 50 rows per batch) plus `retentionStatements` (resolved issue_reports older than 180 days, 20 per batch; expired approvals) only when (a) an authenticated member's event creates a new 10-minute bucket row with capture on, or (b) capture is off and an authenticated member's event arrives, at most once a minute per instance. Owner `review_issue_reports` also runs `retentionStatements` (not `SWEEP`). Pre-auth failures and rate-limit events never trigger cleanup. No Worker has a cron trigger. So if no member is active, nothing is deleted. Production (counts only, 12:00 PM CT): 519 diagnostic rows, oldest Oct 19, 0 past 30 days; 1 resolved report (Oct 24); 0 approvals. No violation today. Fix: PR #96 adds `runRetention()` and a `scheduled()` entry. `release-worker-content.mjs` only PUTs `/content` and checks settings; it neither adds nor removes cron triggers, so enabling needs a separate owner-approved `PUT .../workers/scripts/whoop-lens/schedules` after release.

**RB-017 (Medium, privacy/UX).** `revokeWhoopConnection` (`cloudflare/src/whoop-oauth.mjs`) records a revocation and deletes `whoop_oauth_states`/`whoop_connections` locally. No call to WHOOP is made, and the `disconnect_whoop` result is only `{disconnected, removed}`. Notion's disconnect, by contrast, tells the member to also revoke in Notion. Smallest fix: add the same guidance text; a WHOOP-side revoke call needs WHOOP API confirmation first.

**RB-018 runbook.** PR #97 adds `docs/runbooks/former-member-deletion.md` (private intake, identity verification, external revocation, counts-only dry run, ordered D1 delete, private confirmation) with tests that every member-keyed table is covered and that the delete block runs with foreign keys on.

**RB-019 assessment.** `notion-client.mjs` maps a fetch exception to a synthetic 503 and an upstream 5xx to its real status, then both to `service_unavailable`. Splitting would separate Workers egress failures from Notion outages, but member guidance is identical (retry later), volume is a handful of events, and the HTTP status is already on the error. Not worth a change now; revisit if Notion errors become frequent.

**RB-020 coordination rule (proposed).**
1. One writer per branch. Before the first push, comment "Taking branch X" on its PR; the new-branch PR body may state it.
2. Always fetch and compare the remote head with the head you tested immediately before pushing. If it moved, do not push: comment on the PR instead.
3. Never force-push, rebase or amend a pushed commit.
4. After any push, check whether a Codex review is pending for the new head before requesting one; never request twice for the same head.
5. Every PR comment states the head SHA it refers to.

Evidence: every commit since 11:00 AM on #91/#93/#94/#95 is authored and committed as Aaron Strasler with no signature (pushed through connectors using the owner's credentials). Commit metadata cannot tell agents apart; PR comments made with the cursor connector show `performed_via_github_app: cursor`.

**PR #94 release steps (owner approval required).**
1. Read-only check: custom domains are apex to `whoop-lens`, www to `whoop-lens-site`, auth to `whoop-lens-auth`; zone Worker routes are empty (verified 11:45 AM and 12:00 PM CT).
2. Build: `wrangler deploy --dry-run --outdir <dir> -c cloudflare/oauth/resource/wrangler.jsonc` at the approved head; record sha256 of `<dir>/index.js`.
3. Snapshot settings and the current deployment; dry run `node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens --snapshot <snap> --bundle <dir>/index.js` (add `--offline` without an API token). Expect `apply:false`, `bindingCount` 38, unchanged settings; note the rollback version.
4. With approval only: the same command with `--apply`.
5. Smoke checks: `curl -sI https://whooplens.tech/` gives 301 to `https://www.whooplens.tech/`. `/privacy`, `/terms` and `/support` (with and without a trailing slash) give 301 to the slashed www path, and `/privacy?x=1` keeps `?x=1`. Then confirm: `/mcp` without a token gives 401; `/.well-known/oauth-protected-resource/mcp` and `/.well-known/assetlinks.json` give 200; POST `/` is not redirected; `https://www.whooplens.tech/privacy/` gives 200.
6. Rollback (owner approval; the release script cannot redeploy an existing version): restore the recorded version through Cloudflare Deployments or `wrangler rollback <version-id> --name whoop-lens`, as in `docs/release-checklist-20261024.md`. Then GET settings and confirm they equal the saved snapshot (38 bindings), and repeat the smoke checks. Capture a fresh snapshot before any later release, because the pre-release one now fails the version-drift check.

**Refresh monitoring (RB-001).** By 12:00 PM CT there was no new refresh-failure or 401 event since the 10:34 AM deploy. The only events since are 7 `hc_delivery_stored` successes. m2's next expiry is 12:31 PM CT.

## Fifth pass (Oct 25, about 12:45 PM CT)

### RB-001 refresh observations (read-only D1 metadata)
| Sample (CT) | Member | Evidence | Outcome |
|---|---|---|---|
| 11:31 AM | m2 | `updated_at` 16:31:15Z, expiry +1 h | Successful refresh |
| 12:32 PM | m2 | `updated_at` 17:32:11Z, expiry 18:32Z | Successful refresh |
| ongoing | m1, m3 | Unchanged since Oct 18 / Oct 24 | No reads, so no refresh attempted; m3 left untouched |

No `whoop_refresh_*` or 401 events since the 10:34 AM CT deploy; the only events are `hc_delivery_stored` successes. Two samples from one member don't show the fix is permanent.

### RB-016: scheduled retention, verification and the exact schedule change
- **Independent of members:** `scheduled()` calls `runRetention(env.DB)`, which has no user context.
- **Scope:** writes go only to `diagnostic_events` (`last_at` older than 30 days), `issue_reports` (status `resolved` and `updated_at` older than 180 days) and `issue_report_approvals` (expired). Tests on f915111 prove that 1000-day-old rows in whoop_recovery, whoop_sleep, health_connect_records, samsung_health_records, medical_context, flare_journal, flare_consent, health_import_consent, whoop_connections and notion_accounts survive.
- **Failure handling:** at most 20 rounds of 50/20/50 deletes. Any D1 error stops and returns `ok:false`. The log line is `{event:'retention',ok,deleted}`, with no ids.
- **Config:** neither wrangler.jsonc declares `triggers`. `release-worker-content.mjs` PUTs only `/content` and checks `/settings` and `/deployments`, so it neither adds nor removes cron schedules. Correction (sixth pass): per Cloudflare's Cron Triggers docs, `wrangler deploy` replaces schedules only when `triggers.crons` is defined; with `triggers` undefined it leaves existing schedules in place (`crons: []` would remove them). Plain `wrangler deploy` stays forbidden regardless. Production schedules are `[]` today.
- **Change, for separate owner approval and only after #96 is released:**
  1. `GET /accounts/<acct>/workers/scripts/whoop-lens/schedules` must return `[]`.
  2. `PUT /accounts/<acct>/workers/scripts/whoop-lens/schedules` with body `[{"cron":"17 9 * * *"}]`. That is 09:17 UTC daily (4:17 AM CDT; 3:17 AM CST after DST ends Nov 1).
  3. Verify: GET returns that one cron. After the next run, Workers Logs shows `{"event":"retention","ok":true,...}`, and D1 counts of diagnostics older than 30 days and resolved reports older than 180 days are 0.
  4. Roll back with the same PUT and body `[]`. GET must return `[]`. The code needs no change; the handler simply stops being invoked.

### RB-017: WHOOP revoke
WHOOP documents `DELETE https://api.prod.whoop.com/developer/v2/user/access` (operationId `revokeUserOAuthAccess`; 204, 400, 401, 429, 500). It needs a valid access token.

| Option | Effect | Risk |
|---|---|---|
| Provider revoke | Access actually ends at WHOOP, and webhooks stop | Needs an unexpired token; an extra network call |
| Local deletion + instructions | No network dependency | Access stays live at WHOOP until the member removes it |
| Fallback when WHOOP is unavailable | Local deletion proceeds; sanitized reason; manual instructions | None beyond the manual step |

Recommendation: PR #98. Try the best-effort revoke first, always delete locally, return a sanitized reason code, and show manual instructions whenever revocation isn't confirmed. It doesn't refresh during a disconnect, so with an expired token it falls back to the instructions. It's off by default via `WHOOP_PROVIDER_REVOKE_ENABLED`.

### RB-018: deletion coverage check
I enumerated the member-keyed tables from migrations 0001–0019: identity_links, whoop_members, access_identity_links, whoop_connections, whoop_oauth_states, whoop_credential_revocations, whoop_connection_generations, whoop_member_request_budget, whoop_recovery, whoop_sleep, whoop_waitlist, health_connect_*, health_import_consent, samsung_health_records, medical_context, flare_*, issue_reports, issue_report_approvals, diagnostic_events (`user_key`), notion_* and ai_* (`user:<id>` scope). Every one appears in the runbook's delete block.
- Tables with no member key: ai_account_snapshot, ai_usage_event, oauth_login_attempts, seat_request_limits.
- seat_request_delivery holds email hashes that expire in ≤24 h.
- `OAUTH_KV` is the only KV namespace, and the runbook covers it. No R2 bucket is bound.

### Observations (not defects)
- One expired `notion_oauth_states` row (expired Oct 24 00:57 UTC) remains. It's unusable, because callbacks require `expires_at>now`, and the member's next `connect_notion` deletes it. Expired seat-request, WHOOP-state, preview and login-limit rows: 0.

## Sixth pass (Oct 25, about 1:35 PM CT)

### RB-001 refresh observations (read-only D1 metadata)
| Sample (CT) | Member | Evidence | Outcome |
|---|---|---|---|
| 1:33:01 PM | m2 | `updated_at` 18:33:01Z, expiry 19:33Z (2:33 PM CT) | Third successful refresh since deploy (11:31, 12:32, 1:33) |
| ongoing | m1, m3 | Unchanged since Oct 18 / Oct 24 | No reads, so no refresh; m3 untouched |

Since the 10:34 AM CT deploy: no `whoop_refresh_*` events and no 401s. The only diagnostics are 12 `hc_delivery_stored` successes (last 1:23 PM CT). Refreshes are inferred from `updated_at` advancing with a new +1 h expiry; a valid-token read changes neither field. Three samples, one member: still not declared resolved.

### RB-016: cron API and release interaction (Cloudflare docs, read this pass)
- **API:** `PUT /accounts/{account_id}/workers/scripts/{script_name}/schedules`, body `[{"cron":"17 9 * * *"}]`; the response lists `schedules[{cron,created_on,modified_on}]`. The PUT replaces the full set, so repeating it is idempotent. Crons run in UTC and take up to 15 minutes to propagate.
- **Release script:** `release-worker-content.mjs` PUTs only `/content`; a later code release does not touch schedules.
- **Wrangler / Workers Builds:** schedules are replaced only when `triggers.crons` is declared; neither wrangler.jsonc declares `triggers`, so a `wrangler deploy` (forbidden here) or a Workers Builds run would leave them. Only `whoop-lens-site` is connected to Workers Builds (CI check name); the `whoop-lens` Worker is not.
- **Risk:** Cloudflare recommends managing crons in config for Wrangler-managed Workers. If someone later adds `triggers.crons` to wrangler.jsonc, a deploy will overwrite the API-set schedule. Mitigation: record the schedule in the release checklist; any future config change must declare the same cron.
- **Idempotency and failure:** every delete is conditional (`last_at`/`updated_at`/`expires_at` cutoff) and bounded (≤20 rounds of 50/20/50). A rerun after a partial run deletes only what is still past the cutoff. A D1 error stops the run with `ok:false`; the next day's run resumes. Health tables are never written (tests on f915111).
- **Rollback:** PUT `[]`; the code stays and is simply not invoked.

### RB-017 (#98): re-verified
- WHOOP OpenAPI (`/developer/doc/openapi.json`): `DELETE /developer/v2/user/access`, `revokeUserOAuthAccess`, OAuth bearer, responses 204/400/401/429/500.
- Mock tests on 6334e63: the request uses `redirect:'manual'`, so a 3xx is reported as `whoop_revoke_rejected` and never followed with the bearer token. Local deletion runs on every outcome (network error, timeout, 401, 429, 5xx, 400, 3xx, expired token, undecryptable token, flag off). Manual instructions are returned whenever revocation is not confirmed. `WHOOP_PROVIDER_REVOKE_ENABLED` is unset in both wrangler.jsonc, so it is off by default.

| Option | What ships | Production change | Risk |
|---|---|---|---|
| (a) Ship with flag off | Clearer disconnect message plus manual WHOOP instructions; no provider call | Code release only | Access stays live at WHOOP until the member removes it |
| (b) Ship and enable | Best-effort provider revoke, then local deletion | Code release **and** a new Worker variable, which changes the binding count from 38 (release script snapshot check) and is a settings publish | One outbound call per disconnect; needs an unexpired token |
| (c) Defer | Nothing | None | Current message stays |

Recommendation: (a) now; (b) later as its own approved settings change.

### RB-018 (#97): operational steps (not executed)
Preconditions: identity verified independently (challenge to an independently established address, or an owner-verifiable authenticated identity; a matching From address is not enough); member resolved to exactly one `user_id`; a second member's rows are never in scope.
1. **Dry run:** run the runbook's count query for the target `user_id`; record per-table counts (24 tables) and the OAUTH_KV keys found. Also run it for one other member as a control.
2. **Owner confirms** the counts and the target in writing.
3. **Delete** with the runbook's single-batch delete block (one D1 transaction, foreign keys on, child tables first), then remove the listed OAUTH_KV keys.
4. **Verify:** rerun the count query: every table 0 for the target; the control member's counts unchanged. No R2 is bound.
5. Tell the requester what was deleted. Nothing in the runbook promises automatic deletion.

### Release queue (one release per PR; none merged or deployed)
| PR | Item | Head | Codex | CI | Deploy needed | Rollback | Risk | Owner approval |
|---|---|---|---|---|---|---|---|---|
| #91 | Backlog (docs) | this head | see review log | green on 7afa6eb | No | Revert | None | Merge |
| #92 | RB-014 refresh-rejected message | 48d8349 | completed, clean | green | Worker release (script) | Restore prior version via Deployments | Message text only | Merge + release |
| #93 | RB-012 deletion-request wording (draft) | e8bd3f4 | completed, clean | green | Site build | Revert | Mailbox must exist | Mailbox confirm + merge |
| #94 | RB-012 apex redirect | 485eb96 | completed, clean | green | Site/Worker release | Revert / prior version | Routing | Merge + release |
| #95 | RB-004/006 diagnostic codes | abaefa7 | completed, clean | green | Worker release | Prior version | New codes only | Merge + release |
| #96 | RB-016 scheduled retention (draft) | f915111 | completed, clean | green | Worker release, then a **separate** schedule PUT | PUT `[]`; prior version | Deletes old diagnostics/resolved reports | Merge + release; schedule separately |
| #97 | RB-018 former-member runbook (draft) | 037b2ad | fresh request 1:30 PM, pending | green | No | Revert | Manual procedure | Merge |
| #98 | RB-017 provider revoke (draft) | 6334e63 | completed, clean | green | Worker release; (b) also a settings change | Prior version; unset flag | See options | Choose (a)/(b)/(c) |
| #99 | RB-021 refresh-success log (draft) | d94121a | completed, clean | green | Worker release | Prior version | One log line | Merge + release |


## Seventh pass (Oct 25, about 2:35 PM CT): status and stopping rules

**Rules.** *Monitoring*: repair tested, Codex reviewed its final commit, findings addressed, no further dev action; waits on owner release or live observation. *Verified Resolved*: completion criteria met in production or by definition. *Outstanding*: needs owner action, member action or evidence. Verified work is not reopened without evidence of regression. No new defect was found this pass beyond the #97 P2 (fixed).

| Status | Items |
|---|---|
| Verified Resolved / closed | RB-005 (expected classification), RB-007 (explained by RB-001/002), RB-010, RB-011 (environment differences), RB-013 (tooling gap, CI covers Android), RB-019 (assessed, no change), RB-020 (workflow documented) |
| Monitoring | RB-001 (live; refreshes observed, see below), RB-014 (#92), RB-012 apex (#94), RB-004/RB-006 (#95), RB-016 (#96 code; schedule separate), RB-017 (#98 Option A), RB-021 (#99), RB-018 (#97 b968067, Codex clean) |
| Outstanding | RB-002 (m3 must reconnect; draft message prepared, not sent), RB-003 (m1: no action needed unless they report a problem), RB-008 (owner device run), RB-009 (needs a second member's consent), RB-012 deletion channel (#93: owner must confirm the mailbox), RB-015 (owner: keep or disable GitHub Pages) |

Release requests: `docs/release-queue.md`.

**RB-001 at 2:35 PM CT (read-only D1).** Evidence: m2 `updated_at` still 18:33:01Z, token expired 2:33 PM CT; no `whoop_refresh_*` or 401 events since the 10:34 AM deploy (only 15 `hc_delivery_stored` successes, last 2:23 PM CT). Inference: no WHOOP read has happened since expiry, so no refresh was attempted yet; this is not a failure. Totals: 3 observed refreshes (11:31, 12:32, 1:33 PM), 0 failures. m1/m3 unchanged and untouched.

## Review log

| Date (CT) | Item | Head | Request | Codex response |
|---|---|---|---|---|
| Oct 25, 3:51 AM | RB-001 | 7f74222 | @codex review | completed: 2 P2 findings, both fixed in 6d57a83 |
| Oct 25, 4:08 AM | RB-001 | 6d57a83 | @codex review | completed: no major issues |
| Oct 25, 4:30 AM | RB-001 | c09ef87 | @codex review | completed: no major issues |
| Oct 25, 11:00 AM | backlog (this PR) | 4eb5ed2 | @codex review (Aaron) | completed 11:02 AM: 1 P2 (RB-004 classification). Accepted; RB-004 reopened |
| Oct 25, 11:09 AM | RB-014 (#92) | 48d8349 | @codex review | completed 11:11 AM: no major issues |
| Oct 25, 11:27 AM | RB-012 deletion (#93) | dc71393 | @codex review | still showed running at 11:45 AM; superseded by e8bd3f4 |
| Oct 25, 11:46 AM | RB-012 deletion (#93) | e8bd3f4 | @codex review (parent) | completed: no major issues |
| Oct 25, 11:42 AM | RB-012 apex (#94) | 485eb96 | @codex review | completed: no major issues |
| Oct 25, 11:42 AM | RB-004/RB-006 (#95) | abaefa7 | @codex review | completed: no major issues |
| Oct 25, 11:42 AM | backlog (this PR) | 1f5947d | @codex review | completed: no major issues |
| Oct 25, 12:05 PM | RB-016 (#96) | e426abb | @codex review | completed: no major issues |
| Oct 25, 12:07 PM | RB-018 (#97) | d6db735 | @codex review | completed: P1 (identity) + P2 (test seeding); fixed in 037b2ad |
| Oct 25, 12:08 PM | backlog (this PR) | cd8e87b | @codex review | completed: 1 P2 (rollback); fixed in 97a51b4 |
| Oct 25, 12:15 PM | backlog (this PR) | 97a51b4 | @codex review | completed 12:17 PM: no major issues |
| Oct 25, 12:15 PM | RB-018 (#97) | 037b2ad | @codex review | still running at 1:29 PM; one fresh request with a brief posted 1:30 PM (allowed after ~60 min) |
| Oct 25, 12:45 PM | RB-016 (#96) | f915111 | @codex review | completed 12:47 PM: no major issues |
| Oct 25, 12:45 PM | RB-017 (#98) | 60fe118 | @codex review | completed: 1 P2 (redirect follow with bearer); fixed in 6334e63 |
| Oct 25, 12:53 PM | RB-017 (#98) | 6334e63 | @codex review | completed 12:56 PM: no major issues |
| Oct 25, 12:46 PM | backlog (this PR) | 7afa6eb | @codex review | superseded by the sixth-pass head before completing |
| Oct 25, 1:04 PM | RB-021 (#99) | d94121a | @codex review | completed 1:05 PM: no major issues |
| Oct 25, 1:35 PM | backlog (this PR) | 93fa6a8 | @codex review | completed 1:36 PM: no major issues |
| Oct 25, 1:30 PM | RB-018 (#97) | 037b2ad | fresh @codex review | completed: 1 P2 (health-only mode removed sign-in mappings); fixed in b968067 |
| Oct 25, 1:44 PM | RB-018 (#97) | b968067 | @codex review | completed 1:46 PM: no major issues |
