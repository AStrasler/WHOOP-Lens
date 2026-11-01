# Android home widget sizing

All six home providers (Daily, Recovery, Steps, Sleep, Vitals, Expanded) declare a
1 x 1 cell footprint. The picker uses a separate one-cell preview that shows an em
dash and no sample measurement. Issue #102 corrected the lock-screen claim: no
provider opts into `keyguard`, and API 36 resources add `not_keyguard`. Samsung
Brief widgets and Now Bar are not provided. The seventh provider, the non-numeric
WhoopLens status widget, uses the same 1 x 1 target, 40dp minimums and maximum
hints (it previously required 180 x 80dp, about three cells, with no maximum).
Settings -> Widgets & privacy -> Placed widget sizes lists each placed widget's
launcher-reported dp bounds for recording One UI cell sizes. Evidence, inference, and the Galaxy
S26 Ultra checklist are in `docs/android-s26-ultra-widgets.md`. Emulator renders
are not One UI cell measurements and are not results from the phone.

## Sizing and content

- `targetCellWidth=1`, `targetCellHeight=1`; minimum/fallback resize bounds 40 x 40dp.
- Both resize axes are enabled. Maximum hints are 320 x 250dp. On the handset
  table in Android's widget layout guide, portrait 4 cells are 276dp wide and 5
  cells are 349dp; portrait 2 cells are 220dp tall and 3 cells are 337dp. The
  hints sit between those published estimates. They are **not Samsung cells** and
  **not a maximum-cell attribute**. Launchers can ignore them. The guide's table
  is a Pixel 4 demonstration.
- Actual `OPTION_APPWIDGET_SIZES` are used to build native size-specific RemoteViews
  (up to Android's 16-layout limit). Older host options fall back to portrait and
  landscape min/max size pairs. Resize callbacks rebuild from the current cache.
- Compact views show the selected primary metric; supporting measurements appear
  as width, height and font scale permit. Wide two-row views use two columns at
  normal font sizes and stack at large font scales. Steps are no longer permanently
  forced into a compact layout.
- Existing dark background, corner treatment, Inter and JetBrains Mono are retained.
  Long labels are deliberately ellipsized, with full information available to
  accessibility services and in the app. The primary value auto-sizes within its
  bounds. Tight views abbreviate steps/durations; exact values, units, sources,
  measurement/read timestamps and stale status remain in accessibility text.
- Missing values use an em dash, never a fabricated zero. Stale displayed values
  use amber and a Saved label where space permits. Visible source labels appear
  when space allows; compact source attribution remains in accessibility text.

## Unchanged safeguards

Widgets only consume the existing encrypted account-scoped dashboard cache.
Signed-out, account-mismatched, locked, hidden and summary states cannot format
cached measurement values. Detailed values still require the existing explicit
privacy preference. Every size has the existing immutable tap-to-open action.
No OAuth, screenshot policy, permissions, networking, refresh schedule, upload,
health deletion, production configuration or API changes are included.
`ManualSync.ENABLE_UPLOADS=false` remains unchanged.

## Verification

Commands run against the local Android build copy, with cached dependencies:

```powershell
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest --offline --no-daemon --console=plain
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs
node --test docs/android-companion.test.mjs
git diff --check
```

The Android suite covers sizing/content selection, font budgets, missing/null/zero
values, stale batches and measurement timestamps, privacy, sign-out, account
separation, exact accessible steps, and replacement-cache refresh. Node regressions
check all six declarations, picker layouts, cache-only rendering and existing
foreground/background update wiring, plus unchanged auth and transfer controls.

The separate test APK verifies installed provider metadata and produces 110 native
RemoteViews PNG renders on the API 36 emulator: all six providers at five test
bounds and both 100%/200% font scales, plus missing, account-mismatch, summary,
stale and long-label cases for Expanded. Primary text fit is asserted. Bounds used
were 56x56, 150x72, 150x160, 320x72 and 320x160dp at that time; labels such as 1x1 and 4x2 describe
intended test scenarios, **not measured Samsung launcher cells**. Images use test
fixtures, no personal health records. They are native view renders, not proof of
placement in Samsung's launcher. Existing emulator Keystore persistence/erasure
and stale-account WorkManager checks also run. No new background transfers run.

Local evidence and an installable debug APK are saved under the development
worktree's ignored `repair-results/widget-sizing/` directory. The previous APK,
original implementation commit and backups are retained.

## Can the 4 x 2 maximum be enforced? (#102 investigation, Nov 1, 2026)

**Short answer: not reliably from the app.** The original requirement (1 x 1 minimum,
4 x 2 maximum on the placed widget) is **not complete**. The 1 x 1 minimum is met for all
seven providers. The 4 x 2 maximum depends on the launcher.

What the platform offers:

- Android's widget layout guide describes `maxResizeWidth`/`maxResizeHeight` (API 31+) as
  the maximum size the launcher allows the user to resize to, in **dp**. There is no
  maximum-cell attribute. The guide also says cell size and widget margins vary across
  devices.
- AOSP Launcher3 turns the dp maximum into a cell span with
  `ceil((maxResize + padding + spacing) / (cellSize + spacing))`, capped by the grid. Because
  it rounds **up**, a dp value lands on a different span on each grid: the same 320dp can be
  3, 4 or 5 columns depending on column count, screen width and the user's display size.
  (Source: Launcher3 `LauncherAppWidgetProviderInfo.initSpans`/`getSpanX`.)
- Samsung One UI Home is closed source and publishes no widget-span rule. Whether it uses
  the same rounding, and its cell sizes on the Galaxy S26 Ultra, can only be measured on
  the phone.

So no single dp pair yields exactly 4 x 2 on every grid (4x5, 4x6, 5x5, 5x6) and display
size. A value tight enough to stop a fifth column on a 5-column grid can stop the fourth
column on a 4-column grid.

Alternatives considered:

| Option | Effect | Verdict |
| --- | --- | --- |
| Tune `maxResizeWidth/Height` from measured S26 Ultra cell sizes | Exact 4 x 2 on the measured grid; other grids may differ | **Recommended.** Needs the physical session |
| Width-qualified provider XML (`xml-w400dp` etc.) | Adjusts for screen width only, not the user's grid or display-size choice | Partial; only after measurements |
| Render 4 x 2 content centered in larger frames | Does not stop the launcher; adds empty space the requirement forbids | Rejected |
| Disable resizing | Breaks the 1 x 1 to 4 x 2 range | Rejected |

Settings -> Widgets & privacy -> Placed widget sizes is a **measurement aid**, not a
completion of this requirement. It shows the launcher-reported dp bounds per placed widget
so the S26 session can record what each cell span maps to. Once recorded, the follow-up is
to set the hints so the S26 Ultra's default grid stops at 4 x 2, and document the grids it
was verified on.

Automated coverage (`WidgetFitInstrumentation`, emulator workflow `android-widget-fit.yml`):
all seven providers' installed metadata; native renders at launcher-like sizes from one
cell to 4 x 2 at 100/130/200% fonts; primary text fit; no clipped status lines; full status
text and widget descriptions available to accessibility; Summary descriptions carry no
measurements. It cannot measure One UI placement or spans.

## Physical Samsung checks still required

On the Galaxy S26 Ultra, check all six picker footprints, actual placement and
resize handles from 1x1 through 4x2, grid/margin variations, 100%/200% font sizes,
app reopen/cache refresh, device reboot, lock/unlock, sign-out/account switching,
and missing WHOOP/Health Connect records. Check that tapping each size opens the
app. Existing widgets may need removal/re-adding if One UI retains old metadata.
No phone installation, push, merge, deployment, or production change is authorized
by this local work. Emulator-only installation was separately approved.

Android sizing reference: https://developer.android.com/develop/ui/views/appwidgets/layouts

## Final local results

- Android: 88 unit tests, zero failures (12 new widget presentation tests).
- Node/Worker/site regression suite: 568 passed, zero failures; final Android
  wiring subset: 6 passed.
- Android lint: zero errors, 46 existing warnings (same categories/count as the
  preceding screenshot-fix baseline). Two new wide-layout warnings were fixed.
- Debug and separate instrumentation APK assembly succeeded; debug signature
  verified against the existing certificate. APK version 0.2.2-dev, code 4.
- Emulator: 110 widget renders passed, provider metadata checked for all six,
  encrypted cache persistence/erasure and old-account background work passed.
- Visual review: compact/expanded views at 100%/200% inspected; long labels use
  intentional ellipsis rather than overflowing. Samsung physical testing pending.

## Changed files

- `android/app/build.gradle.kts` (installable debug version increment)
- `android/app/src/main/java/io/github/astrasler/whooplens/LensWidgets.kt`
- `android/app/src/main/java/io/github/astrasler/whooplens/WidgetPresentation.kt`
- `android/app/src/main/res/layout/lens_widget_responsive.xml`
- `android/app/src/main/res/layout/lens_widget_wide.xml`
- `android/app/src/main/res/values/strings.xml`
- `android/app/src/main/res/xml/widget_daily.xml`
- `android/app/src/main/res/xml/widget_recovery.xml`
- `android/app/src/main/res/xml/widget_steps.xml`
- `android/app/src/main/res/xml/widget_sleep.xml`
- `android/app/src/main/res/xml/widget_vitals.xml`
- `android/app/src/main/res/xml/widget_expanded.xml`
- `android/app/src/test/java/io/github/astrasler/whooplens/WidgetPresentationTest.kt`
- `android/app/src/androidTest/java/io/github/astrasler/whooplens/DesignReviewInstrumentation.kt`
- `docs/android-companion.test.mjs`
- `docs/android-widget-sizing.md`
