# WhoopLens release queue (prepared Oct 25, 2026, 1:55 PM CT)

Nothing here is approved. Each entry is an independent request; approving one approves nothing else. Releases are one PR at a time, in any order (all candidates merge cleanly with each other and with `main`; combined suites: cloudflare 517/0, provider 25/0, docs+supabase 84/0, site 6/0).

## Retention schedule (current)

The live `whoop-lens` cron is `17 9 * * *` (09:17 UTC). Only `cloudflare/oauth/resource/wrangler.jsonc` declares it, as `triggers.crons`. `cloudflare/wrangler.jsonc` (legacy staged, same Worker name) and `cloudflare/oauth/auth-server/wrangler.jsonc` declare no triggers.

Per Cloudflare's Cron Triggers docs, `wrangler deploy` replaces previous schedules with `triggers.crons` when that property is set, removes them when `crons` is `[]`, and leaves them when `triggers` is omitted. A non-dry-run deploy of the resource config therefore replaces the live schedule with exactly `17 9 * * *`. A deploy of the legacy config leaves the schedule in place and is still forbidden, because that file is not the production config and a plain deploy overwrites bindings and flags.

Do not pass `--triggers`, `--schedule`, or `--schedules`, and do not run `wrangler triggers deploy`. Those commands replace the attached cron list. Production code updates stay on `cloudflare/scripts/release-worker-content.mjs`, which PUTs only `/content` and does not call `/schedules`.

## Common procedure (resource Worker `whoop-lens`)
1. Owner approval for the specific entry. Merge that PR only.
2. **Pre snapshot:** capture read-only `GET …/workers/scripts/whoop-lens/settings` and `…/deployments` into `<pre.json>` as `{workers:[{name,settings,deployment}]}` (the format the script reads; it does not create snapshots). Confirm 38 bindings and record the current version id as the rollback target (as of 1:50 PM CT: `a2fd99ec…`, deployed 10:34 AM CT).
3. **Build:** `cloudflare/node_modules/.bin/wrangler deploy --dry-run --config cloudflare/oauth/resource/wrangler.jsonc --outdir <dir>` at the merged commit; record sha256 of `<dir>/index.js`.
4. **Dry run:** `release-worker-content.mjs --worker whoop-lens --snapshot <pre.json> --bundle <dir>/index.js`. It refuses if settings or the deployed version drifted from `<pre.json>`; the plan must show `bindingCount 38` and `rollbackVersion` = the recorded version.
5. **Apply:** same command with `--apply`.
6. **Post snapshot:** the script re-checks settings identity after upload; also capture a fresh snapshot, compare settings and all 38 bindings with `<pre.json>`. The content upload must leave schedules exactly `[{"cron":"17 9 * * *"}]`. See the retention schedule section above before any Wrangler command.
7. **Smoke:** `GET https://whooplens.tech/.well-known/oauth-protected-resource` → 200; `POST /mcp` without a token → 401; plus the entry's own checks.
8. **Rollback:** restore the recorded prior version through Cloudflare Deployments (dashboard, or `wrangler rollback <prior-version-id> --name whoop-lens`). The content script cannot redeploy an old version. Then repeat step 6–7 against `<pre.json>`.

Never plain `wrangler deploy`. No migration, secret, binding, route or DNS change is part of any entry below.

## Entries

### R1 — #92 rejected-token guidance
- **PR/commit:** #92 @ 48d8349. CI green; Codex completed on 48d8349, no major issues.
- **Changes:** when WHOOP rejects the stored refresh token, the tool error says retrying won't help and to reconnect WHOOP. **Unchanged:** all other errors, data, auth.
- **Settings:** none. **Verify:** smoke; no new `whoop_refresh_*` error rate change. **Rollback:** prior version.
- **Authorization text:** "Approve merging #92 at 48d8349 and releasing it to whoop-lens with the release script (dry run, then --apply)."

### R2 — #94 bare-domain redirects
- **PR/commit:** #94 @ 485eb96. CI green; Codex clean on 485eb96.
- **Changes:** on the apex, GET/HEAD of exactly `/`, `/privacy[/]`, `/terms[/]`, `/support[/]` return 301 to the same path on `www.whooplens.tech` (query kept). Exact-match map: `/mcp`, `/.well-known/*`, the WHOOP callback, the Health Connect webhook and every other path are untouched. **Unchanged:** routes, DNS, auth worker.
- **Settings:** none. **Verify:** `curl -I https://whooplens.tech/` → 301 `www…/`; `/privacy` → 301; `/.well-known/oauth-protected-resource` → 200; `/mcp` unauth → 401. **Rollback:** prior version.
- **Authorization text:** "Approve merging #94 at 485eb96 and releasing it to whoop-lens with the release script."

### R3 — #95 diagnostic classifications
- **PR/commit:** #95 @ abaefa7. CI green; Codex clean.
- **Changes:** distinct sanitized reason codes for AI-summary fallback and Notion failures. **Unchanged:** member-facing behaviour, fallback output, no ids in codes.
- **Settings:** none. **Verify:** smoke; new codes appear only as codes in `diagnostic_events`. **Rollback:** prior version.
- **Authorization text:** "Approve merging #95 at abaefa7 and releasing it to whoop-lens with the release script."

### R4 — #96 retention code (code only)
- **PR/commit:** #96 @ f915111. CI green; Codex clean on f915111.
- **Changes:** adds a `scheduled()` handler that deletes diagnostics >30 days, resolved reports >180 days, expired approvals; bounded; fails closed. Inert until a schedule exists. **Unchanged:** health tables (tests prove 1000-day health rows survive), schedules stay `[]`.
- **Verify:** post snapshot schedules `[]`. **Rollback:** prior version.
- **Authorization text:** "Approve merging #96 at f915111 and releasing it to whoop-lens. No schedule."

### R5 — #96 schedule (separate, after R4)
- **Current:** `GET …/workers/scripts/whoop-lens/schedules` → `[]` (read 1:50 PM CT; auth and site Workers also `[]`).
- **Change:** `PUT …/workers/scripts/whoop-lens/schedules` body `[{"cron":"17 9 * * *"}]` — 09:17 UTC daily = 4:17 AM CDT, 3:17 AM CST after Nov 1. The PUT sets the full list (replaces, not appends), so repeating it is idempotent. Propagation up to 15 min.
- **Persistence:** the release script uploads only `/content` and does not call `/schedules`. The Oct 25 note that no Wrangler file declared `triggers` is historical. The current rule is the retention schedule section above: the resource config now declares `17 9 * * *`, so a non-dry-run `wrangler deploy` of that config replaces the live schedule with that list. Do not pass `--triggers`, `--schedule`, or `--schedules`, and do not run `wrangler triggers deploy`.
- **Safety:** conditional bounded deletes; rerun deletes only what is still past cutoff; a D1 error stops with `{"event":"retention","ok":false}` and the next day retries; health tables never written.
- **Verify:** GET shows the cron; next run logs `{"event":"retention","ok":true,…}`; counts of diagnostics >30 d and resolved reports >180 d are 0; health table counts unchanged.
- **Rollback:** PUT `[]`, GET `[]`.
- **Authorization text:** "Approve setting whoop-lens schedules to [{\"cron\":\"17 9 * * *\"}] via the Cloudflare API after R4 is live."

### R6 — #98 Option A (flag off)
- **PR/commit:** #98 @ 6334e63. CI green; Codex clean on 6334e63 (earlier redirect P2 fixed).
- **Changes:** disconnect reply states WHOOP access was not revoked and gives manual WHOOP instructions; local token deletion unchanged. Provider revoke code ships but is off: `WHOOP_PROVIDER_REVOKE_ENABLED` is not set anywhere. **Unchanged:** bindings (38), WHOOP is never called.
- **Verify:** binding count 38 and no new variable in post snapshot. **Rollback:** prior version.
- **Authorization text:** "Approve merging #98 at 6334e63 and releasing it to whoop-lens with provider revocation disabled. Do not set WHOOP_PROVIDER_REVOKE_ENABLED."
- Option B (enable) is a separate future settings change (binding count 39) and is not requested.

### R7 — #99 refresh-success log
- **PR/commit:** #99 @ d94121a. CI green; Codex clean on d94121a.
- **Changes:** one console line `{"event":"whoop_refresh","outcome":"ok","rotated":true|false}` after a committed refresh. No ids, tokens, scope, expiry, health data; no D1 write. **Unchanged:** refresh logic.
- **Verify:** after m2's next natural refresh, Workers Logs show the line and D1 `updated_at` advances. **Rollback:** prior version.
- **Authorization text:** "Approve merging #99 at d94121a and releasing it to whoop-lens with the release script."

### R8 — #91 docs merge
- **PR/commit:** #91 (this branch, latest head). Docs only (backlog, CONTRIBUTING, this file); no deploy.
- **Authorization text:** "Approve merging #91 at <head>."

### Pending (not requestable yet)
- **#93** @ e8bd3f4 (Codex clean): needs owner confirmation that `whoop-lens@outlook.com` is approved and monitored for private deletion requests. Site pages only; no automated-deletion or turnaround promises.
- **#97** @ b968067: two-mode runbook (health-data-only keeps sign-in mappings; full deletion removes all 24 member-keyed tables + KV grants). Codex completed 1:46 PM CT on b968067, no major issues. Docs only. Merge request: "Approve merging #97 at b968067." Ships alongside #93 once the mailbox is confirmed; no production deletion is part of it.
