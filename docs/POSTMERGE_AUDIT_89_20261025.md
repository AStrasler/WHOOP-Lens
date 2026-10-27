# WhoopLens post-merge audit: PR #89

Audit date: October 25, 2026 (America/Chicago). Base/main verified:
`4630e757d8f2d00c383df9c61140e16f94c1f168`. No merge, production deployment,
settings/secret/client/route/membership change or health-data write was performed
by this audit. Private raw evidence stays in ignored `repair-results/postmerge-audit/`.

## VERIFIED: live components

* Nine www HTML surfaces (seven published content pages, Android callback fallback
  and custom 404) return expected 200/404 statuses and WhoopLens titles/copy, with
  no spaced project name. Visible independence notices remain on the seven main
  content pages. Logo bytes match `docs/logo.jpg`; internal navigation/image links
  return 200. Live CSP, nosniff, frame denial and referrer controls remain present.
  The logo was visually inspected; the prior rendered homepage check was clean.
* OAuth discovery returns the existing issuer, resource, endpoints, S256 support
  and refresh-token grant. Anonymous, invalid-token and spoofed-identity-header MCP
  requests return 401/no-store and the correct resource-metadata challenge. A
  missing-client authorize request returns 400/no-store with the Android callback
  allowed by the deployed CSP. No client or grant was registered for testing.
* The connected authenticated MCP returned all 20 capability entries and 40 tool
  permissions, an authoritative `source=whoop` profile, and the owner's own eligible
  link. Only the owner inventory exposes report review/update/link lookup. No PII
  or measurement values are included here. Live WHOOP reads therefore worked for
  this account; that does not establish every member's grant health.
* Runtime source hierarchy explicitly separates WHOOP, Health Connect, Samsung
  Health and user-entered records. Compiled production code contains no retired
  Supabase auth/rest URL. Current local boundary, source-attribution, immutable
  legacy-source and synthetic multi-member isolation regressions pass. No Supabase
  project was restored, queried or modified; its standalone availability was not
  tested because it is not the active OAuth/MCP path.
* D1 diagnostics query selected only aggregate fixed codes/counts/times and reported
  zero rows written. Seventeen WHOOP refresh failures last occurred at
  `2026-10-25T04:45:33.689Z`, before the branding deployment. They are not evidence
  of a #89 regression. Existing HC webhook deliveries continue to be recorded;
  this audit enabled no phone uploads. In the bounded post-merge auth-log query,
  the single authorization failure was our expected `authorize_request/client_missing`
  control at `2026-10-25T08:54:16.911Z`, not an unexplained new sign-in failure.

## VERIFIED: exact deployment state (all versions serve 100%)

| Worker | Version | Deployed at (UTC) | Provenance |
|---|---|---|---|
| whoop-lens-site | `49ca59db-13ad-4848-8b42-1d23f704c659` | 2026-10-25 08:31:03 | Build `652628d2-1bbe-4d79-a603-6f98faf4bb30`, main `4630e757d8f2d00c383df9c61140e16f94c1f168` |
| whoop-lens | `5f9c0f05-1c70-4b62-b17f-460f42d35453` | 2026-10-24 06:59:07 | PR #83 / `c77e2ce04a3160b3c8572212014e1301a085177c`; live module SHA-256 matches the preserved release record |
| whoop-lens-auth | `b1d574f0-ac10-4640-b524-e53cfd7caa11` | 2026-10-24 12:13:56 | Deployment annotation identifies approved repair `3f218541fa5f3bc6296b06a5d26a7ceb10c305e9`; live callback/diagnostics verified |

Live MCP module SHA-256:
`9ef2845ca39d63f4aabcca9d6a9fc428eb16a3dd387d6422fdbda71e43d859aa`.
Live auth module SHA-256:
`95b23ef71842bc7583741705ede62d1a73c5d34fdb5ef1832d217bb2d39e823b`.
MCP retains 38 bindings; auth retains 11; site has none. Observability and query
redaction are enabled. Checked-in disabled staging configs are not production
settings and must never be used as an ordinary production deploy command.

## FIXED locally: a future auth deployment would regress Android sign-in

This predates #89. The approved, deployed `3f21854` repair was on the Android
workstream but absent from main. Main's consent `form-action` omitted the Android
callback; its authorization-stage diagnostics were also missing. Deploying a fresh
main auth bundle merely to change branding would reintroduce screenshot-proven
consent redirect blocking. This audit did not reproduce that defect on production:
production already has the fix.

Reconciled only the previously deployed runtime fix in `cloudflare/oauth/consent.mjs`,
`cloudflare/oauth/auth-server/src/consent-flow.mjs` and `oauth-diagnostics.mjs`, retaining
WhoopLens branding. Restored its focused stage, diagnostics, browser-chain and
provider regressions. The strict CSP test failed against main before reconciliation
and passes afterward; Android callback, ChatGPT redirect, foreign-host rejection,
expired/replayed consent, PKCE/state and credential-free diagnostic behavior are covered.
No wildcard, client ID, callback address, grant, access policy or secret changed.

## FIXED locally: intermittent privacy-test false failure

Historical run `40174161866` also failed `member-facing report responses contain no
internal detail or health data`. Its whole-response substring check rejected `45`,
including when that digit sequence occurred randomly in a valid public `WL-...`
reference. Forced `WL-AB45CDEF` reproduced the failure deterministically. The test
now checks exact response fields/reference, removes only that validated reference
from the leak scan, and retains health/internal-code/request-ID/member-ID assertions.
Only `cloudflare/test/member-diagnostics.test.mjs` changes; production reporting is
unchanged. All 44 member-diagnostic tests pass. This flake predates the rebrand.

## VERIFIED: why historical staging runs failed

The inspected branch-run page contains 27 staging runs: 25 historical failures and
2 successful runs at `dd52869`. Every recorded failing run included the real-clock
MCP report test's fixed October 23 diagnostic timestamp, now outside its permitted
window. PR #89 already fixes this by generating a recent synthetic timestamp for
that real-clock path, without relaxing timestamp validation. Earlier branding
commits also had old-name test snapshots and an AI vocabulary mismatch: new
WhoopLens estimate prose was rejected until `whooplens` was added to the gated
stress vocabulary. Those fixes are present in merged #89 and their tests pass.
The random-reference flake above was not fixed by #89; this audit fixes it.

No workflow is disabled, no failure ignored and no test skipped to get green checks.
All nine post-merge checks on `4630e75` were successful, including GitHub Pages and
Cloudflare site publishing. Both site deployment paths trigger on main changes;
merging documentation/backend work can therefore publish the public site too.

## Local final verification

* Full Node/Worker/site suite: **580 passed, 0 failed/skipped**, including real
  local-D1, Chrome consent-chain, OAuth SDK and synthetic owner/member isolation tests.
  Command: `node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs`.
* Android main-tree `testDebugUnitTest lintDebug assembleDebug`: **38 unit tests**,
  **0 lint errors / 35 warnings**, successful assembly. Version/code and application
  ID unchanged; compiled label is WhoopLens Companion. This is main's companion,
  not the separate unmerged 0.3.0 BLE candidate. No phone installation/publication.
* `node site/build.mjs` and whitespace checks pass.
* Both Workers bundle with `wrangler deploy --dry-run` only. Offline code-only
  release plans preserve the captured 38/11 binding sets and current rollback IDs.
  Configs are used for compilation only, never for an ordinary production deploy.

## UNRESOLVED / BLOCKED: approval and actual-device gates

* Public website branding is live. Auth seat page, resource metadata and MCP guidance
  still use the old project name because auth/MCP were not part of the approved
  site deployment. Correct rebranded code plus the reconciled auth fix is prepared;
  completing that rollout needs review/merge and separately approved code-only
  deployment of whoop-lens-auth and whoop-lens. Preserve complete production settings.
* Live token expiry/rotation, a fresh browser sign-in/reconnection, Samsung app
  update and real second-account isolation were not forced or simulated using real
  credentials. Local regressions cover them; live validation requires the owner or
  separately authorized test accounts. Existing grants were not reset or revoked.
* PR #84 remains draft with unique future requirements. #85 and #86 each conflict
  in Android README, MainActivity, PermissionsRationaleActivity and error-reports
  test. #87 conflicts in error-reports and whoop-error-transparency tests; it owns
  the pre-existing WHOOP refresh concurrency repair. None was modified or merged.
* No active website/auth/MCP availability regression attributable to #89 was observed
  in these bounded probes. This is not a claim that every production path is healthy.

## Prepared release procedure (owner approval required)

Use the reviewed repair commit, rerun checks, then build the auth and resource
bundles locally with their checked-in configs **and --dry-run**. Capture fresh live
settings/version snapshots immediately before release. Review settings equality
and rollback points against those above. The existing helper defaults to read-only:

```powershell
node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens-auth --snapshot <FRESH_PRIVATE_SNAPSHOT> --bundle <AUTH_BUNDLE>
node cloudflare/scripts/release-worker-content.mjs --worker whoop-lens --snapshot <FRESH_PRIVATE_SNAPSHOT> --bundle <RESOURCE_BUNDLE>
```

Only after explicit deployment approval add `--apply`, auth first then resource.
The helper uses code-only PUT /content, guards settings/version drift and verifies
settings afterward. Never deploy with the ordinary checked-in Wrangler config.
Recheck discovery, consent CSP, anonymous rejection, authenticated capability/profile
reads and updated names. Owner performs a fresh Samsung sign-in, restart persistence
and eventual expiry/refresh check. If regression occurs, restore the matching prior
Worker version while preserving settings; do not delete grants or health records.
