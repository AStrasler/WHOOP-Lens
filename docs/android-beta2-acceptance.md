# Beta.2 application-wide acceptance changes

The existing glass surfaces, gradients, tokens, fonts, colours, navigation controls, permission boundaries and private cache remain. This cycle changes information placement and shared layout behavior.

| Destination | Redundancy/layout finding | Correction |
|---|---|---|
| Home / Recovery | Source read summaries repeated above attributed cards and again in Sources; global upload-off paragraph duplicated Settings | Detailed read summaries live in Sources & Freshness; individual attribution and stale/partial warnings remain. Recovery/stat actions stay independently accessible. |
| Overview | Generic explanatory sentence and repeated cached-snapshot wording competed with comparisons | Keep source, time, actual comparisons and stale warning; remove generic repetition. |
| Activity / sessions | Global source priority prose repeated card attribution and dedicated source information | Keep source chips, individual timestamps and session-overlap warning; detailed source priority lives in Sources. |
| Sleep | Duration cards duplicated the per-source session cards; missing-night prose repeated; four weekly cards repeated source chips | Duration and its measurement action join the attributed session card; one missing-night explanation; one attributed weekly summary card. |
| Vitals | Repeated general interpretation disclaimer; crowded shared graph timestamps | Retain the body/skin-temperature distinction; general provenance lives in Sources; shared chart layout fixed. |
| Metric details / Recovery details | Top-bar title repeated as card heading; source repeated in section heading and footer read summaries | One title, source chip and measurement timestamp; records retain individual writing-app provenance. Detailed baseline/coverage context remains in this dedicated view. |
| Health Connect | All category explanations repeated the permission-choice dialog; prepared-only upload widgets duplicated Settings | Landing page keeps granted categories and permission controls; explanations remain at the actual permission decision; link to one operational cloud-sync control area. |
| Settings / Preferences | Secondary BLE/licenses buttons preceded primary account controls; cloud section was inert preparation | Account/preferences first; secondary destinations in About & help; working reviewed sync workflow with accurate readiness/time/errors. |
| Navigation / Sources | Drawer repeated both source chips; detailed source information was hard to reach if Home card hidden | Preserve navigation style and destinations; add direct Sources & Freshness access; no duplicate drawer source chips. |
| Direct BLE | Both tick and millisecond R-R representations and always-expanded connection diagnostics | Keep live freshness, source/device, contact and millisecond observations; connection diagnostics are available on demand without rebuilding live controls. BLE remains local and experimental. |
| Credits / licenses | All complete licenses plus inventory expanded into one extremely long screen | Keep incorporation/provenance summaries and every packaged notice; full selectable license texts/inventory open in their own scrollable dialogs. |
| Arrange Home / signed-out | Shared component scaling and duplicate brand heading | Existing layout/privacy controls retained; shared layout matrix covers font/display zoom; one signed-out title. |

## Graph correction

Timestamp selection previously used first/middle/last sample indexes. Clustered heart-rate samples put the middle timestamp close to the first. TrendChart now uses time-spaced tick anchors, measured text bounds, endpoint priority, minimum gaps and duplicate-label suppression. Plot padding is density-aware, axis height respects font metrics, touch hit testing uses the same bounds, and chronological samples/accessible point navigation remain intact. Sleep-stage labels measure their actual font width and receive enlarged vertical space at larger fonts.

## Verification implemented

- Pure chart-layout tests exercise clustered anchors, small widths, normal/enlarged fonts, duplicates, single-point and impossible label bounds.
- App instrumentation renders every destination in the table plus Recovery, HRV, heart-rate and sleep details at normal/200% fonts, checks native text and chart-label bounds, compares stable repeated screenshots, and retains independent navigation/touch/contrast checks.
- Emulator CI runs API 34/36 at 1440×3120 with logical densities 560 and 640. This is display-zoom coverage on stock Android, not a claim of physical Samsung/One UI acceptance.
- Synthetic cloud tests cover the exact four-category protocol, consent, readiness, authentication, account isolation, pause/revoke, withdrawal, retries/upserts, independent successful-sync timestamps and failed-batch rollback. Android tests cover stale/cross-account requests, fresh previews, permissions, categories, explicit confirmation, protocol/response validation and stable retry keys.

All screenshots use synthetic data and are uploaded with the Android CI evidence. Fresh CI on the final source commit determines verification status; this document is not itself a test result. See `docs/releases/0.6.0-beta.2.md` for the protected release process and `cloudflare/docs/companion-beta2-activation.md` for unapplied production gates.
