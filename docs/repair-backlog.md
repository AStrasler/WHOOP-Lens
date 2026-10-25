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

| ID | Severity | Item | Status | Codex | Owner approval needed |
|---|---|---|---|---|---|
| RB-001 | High | WHOOP refresh-token reuse under concurrent reads (PR #87) | Merged and deployed. 11:25 AM check: 0 refresh events of any kind since deploy; no refresh has run on the new code yet. **Not validated** | completed, no major issues (6d57a83, c09ef87) | None now. Release already done by owner. |
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
| RB-016 | Low | Retention deletions (30-day codes, 180-day reports) run only during normal use; no scheduled cleanup | Wording fix on PR #93 | #93 | Owner: approve wording |
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
  5. Rollback = the live version at release time; at 11:25 AM CT that's `a2fd99ec-a4d8-4bb3-8425-2d64fc81c800` (100%; 38 bindings by GET). Re-read it immediately before release.
  6. Run `--apply` only with explicit owner approval. Never plain `wrangler deploy`.
- **Risks:** text only. ChatGPT may paraphrase.

---

## Third pass (Oct 25, about 11:50 AM CT)

**RB-001 evidence (metadata only).** m2's connection row was rewritten at 16:31:15Z (11:31 AM CT), with a new expiry one hour later (17:31:15Z). m2's connection generation is unchanged since Oct 20, so this was not a reconnect: it was a real refresh exchange on the #87 build (live since 15:34Z), and it succeeded. No refresh failure events have been logged since 15:34Z. This is one successful refresh, not proof under concurrency; keep monitoring. m1 and m3 rows are unchanged.

**RB-016: retention is opportunistic.** Evidence: no Worker has a cron trigger. `diagnostics.mjs` runs `SWEEP` and `retentionStatements` (report and approval purges) only inside the capture path, once per new bucket row, or every interval while capture is off. With little traffic, rows can outlive 30 or 180 days. Today no diagnostic row is older than 30 days (the oldest is from Oct 19). PR #93 now says cleanup runs during normal use, so removal can happen later.

**Former-member deletion is manual.** There is no tool for it. PR #93 now says the owner handles these requests by hand, with no fixed response time.

**PR #94 routing (read-only).** The custom domains are: apex to `whoop-lens`, www to `whoop-lens-site`, auth to `whoop-lens-auth`. There are no zone Worker routes and no page rules, and only managed rulesets. The redirect target is always www, which is served by a different Worker, so it cannot loop. The query string is now preserved.

## Review log

| Date (CT) | Item | Head | Request | Codex response |
|---|---|---|---|---|
| Oct 25, 3:51 AM | RB-001 | 7f74222 | @codex review | completed: 2 P2 findings, both fixed in 6d57a83 |
| Oct 25, 4:08 AM | RB-001 | 6d57a83 | @codex review | completed: no major issues |
| Oct 25, 4:30 AM | RB-001 | c09ef87 | @codex review | completed: no major issues |
| Oct 25, 11:00 AM | backlog (this PR) | 4eb5ed2 | @codex review (Aaron) | completed 11:02 AM: 1 P2 (RB-004 classification). Accepted; RB-004 reopened |
| Oct 25, 11:09 AM | RB-014 (#92) | 48d8349 | @codex review | completed 11:11 AM: no major issues |
| pending | RB-012 deletion | dc71393 | PR not yet open | not requested |
| pending | RB-012 apex | 8b6ece4 | PR not yet open | not requested |
| pending | RB-004/RB-006 | 0f08223 | PR not yet open | not requested |
