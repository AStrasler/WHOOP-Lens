# WhoopLens repair backlog

The shared, repo-based chore list. Items are never dropped; resolved items stay with their evidence.
Started on Oct 25, 2026 at 11:00 AM CT. Members are anonymised as m1, m2, ... by sorted id within each query, so labels may not line up across tables. The table names for each item say which query the evidence came from. No tokens, ids or health values appear here.

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
| RB-001 | High | WHOOP refresh-token reuse under concurrent reads (PR #87) | Merged and deployed; post-deploy observation in progress | completed, no major issues (6d57a83, c09ef87) | None now. Release already done by owner. |
| RB-002 | High | m3's WHOOP connection is dead after the Oct 24 reuse incident | Still broken | n/a (no code change) | Member reconnect. We must not force it. |
| RB-003 | Medium | m1's WHOOP connection has been expired since Oct 18 with no activity | Under investigation | not requested | Possibly a member outreach decision |
| RB-004 | Low | AI summary `summary_fallback_filter` events | Expected behaviour (grounding fallback) | not requested | None |
| RB-005 | Low | Health Connect `hc_only_unsupported_types` | Expected classification; tests added in PR #87 | completed (as part of #87) | None |
| RB-006 | Medium | Notion: 1 of 2 accounts connected; one `notion_request_failed` | Under investigation | not requested | None yet |
| RB-007 | Medium | Unauthorized WHOOP reads (401 diagnostics) | Explained by RB-001/RB-002; the classification works | completed (as part of #87) | None |
| RB-008 | Medium | Samsung/Android auth persistence: no physical-device verification | Unverified | n/a | Owner device run |
| RB-009 | Medium | Real second-account isolation: verified only synthetically | Unverified in production | n/a | Another member's explicit consent for a live test |
| RB-010 | Low | Test suite on Node 22.14 can't run `oauth-provider` (`registerHooks`) | Known environment issue; CI uses Node 24 | n/a | None |
| RB-011 | Low | Codex's OAuth suite count (123) vs Grok's (118) | Discrepancy, probably Node or OS version | n/a | None |
| RB-012 | Low | Older open items: apex redirect, Previews config on whoop-lens-site, privacy and terms links in the WHOOP dev app and ChatGPT, GitHub Pages decision, deletion promise on the support page | Open | not requested | Owner for the external settings |
| RB-013 | Low | Android test suite (38 tests) not reproducible on the Grok box (no JDK/Gradle) | Tooling gap | n/a | None |

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
- **Post-deploy verification:**
  - **E:** no non-success diagnostic events since the 04Z hour of Oct 25, as of 11:00 AM CT.
  - **I:** that's too short a window, with too little traffic, to prove the fix in production. Keep watching the first natural expiry bursts (m2's token expires about every hour).
- **Outstanding objections:** none.

## RB-002: m3's WHOOP connection is dead
- **E:** m3's connection has been expired since Oct 24, 23:32Z, and every refresh since has failed.
- **I:** WHOOP revoked the token family after the reuse in RB-001, and only a reconnect restores it.
- **Fix:** none possible server-side without forcing a reconnect, which is not allowed. The member needs to reconnect WHOOP. After #87, a fresh failure is classified as `whoop_refresh_rejected`.
- **Owner:** decide whether to tell the member.

## RB-003: m1's WHOOP connection expired since Oct 18
- **E (`whoop_connections`):** m1 is on a public seat. The connection expired on Oct 18, 23:38Z and has not been written since. There are no diagnostic events for m1 since Oct 23.
- **Suspected:** the member hasn't used WhoopLens since then. Refresh only happens on read. Whether WHOOP refresh tokens expire after inactivity is undocumented, so unknown.
- **Next:** check whether the member guidance and reconnect messaging for an old expired token is accurate. No production action.

## RB-004: AI summary fallbacks
- **E:** m2 had `summary_fallback_filter` partial events (1, 4 and 4) on Oct 23–25.
- **Cause:** the grounding check rejects a summary and the safe fallback is served. Each summary makes 4 parallel calls.
- **Status:** expected behaviour. Revisit if the rate rises.

## RB-005: Health Connect unsupported types
- **E:** m2 had `hc_only_unsupported_types` partial events on Oct 24. HC records arrive daily: 36 to 91 rows per day from Oct 18 to 25 (counts only).
- **Status:** the classification is correct, and tests were added in #87. Ingestion looks healthy.

## RB-006: Notion integration
- **E:** `notion_accounts` has 2 rows, 1 with credentials. One `notion_request_failed` for m2 at Oct 24, 00Z.
- **Next:** read the Notion code paths and the failure classification, and check whether the unconnected row is a stale or abandoned flow. No production action.

## RB-007: Unauthorized WHOOP reads
- **E:** all 401 events in the window belong to m3 at the time of the RB-001 incident.
- **Status:** explained. The per-resource codes worked as designed (PR #75).

## RB-008: Samsung/Android auth
- **E (Codex report):** 38 Android unit tests pass (JVM simulations). No device was available, so it wasn't verified on a physical device.
- **Next:** the owner runs a check on the existing installed app at natural expiry. Grok doesn't touch Android files.

## RB-009: Second-account isolation
- **E:** the synthetic isolation tests pass (`member-isolation-e2e`, and two members in the concurrency tests).
- **Not verified live:** that needs another member's explicit authorization.

## RB-010 – RB-013
See the summary table. These are environment and tooling notes or older open items. Each will be expanded when it's worked on.

---

## Review log

| Date (CT) | Item | Head | Request | Codex response |
|---|---|---|---|---|
| Oct 25, 3:51 AM | RB-001 | 7f74222 | @codex review | completed: 2 P2 findings, both fixed in 6d57a83 |
| Oct 25, 4:08 AM | RB-001 | 6d57a83 | @codex review | completed: no major issues |
| Oct 25, 4:30 AM | RB-001 | c09ef87 | @codex review | completed: no major issues |
| Oct 25, 11:00 AM | backlog (this PR) | (draft) | @codex review | requested |
