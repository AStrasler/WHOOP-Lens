# Galaxy S26 Ultra widgets (issue #102)

This change does not include a phone run. Emulator output is not a Galaxy S26
Ultra result. Do not uninstall WhoopLens or clear its data for the checklist
below.

## Evidence

These points are taken from the cited pages, not from inference.

- Samsung UK support, updated 19 March 2026, describes **Brief widgets** as the
  lock-screen widgets a person adds with **Settings → Wallpaper and style →
  current lock screen → Add widgets** (or by pressing and holding the lock
  screen). It says each supported app has several style options, and “The apps
  supported by the Brief widget feature may vary over time, as they can be
  added, removed, or updated.” The page does not mention `AppWidgetProvider`,
  `widgetCategory`, or `keyguard`.
  <https://www.samsung.com/uk/support/mobile-devices/brief-widgets-on-your-samsung-galaxy-devices-lock-screen/>
- Samsung’s US guide lists lock-screen examples such as Battery, Clock, and
  Reminder, added by touching and holding the lock screen and tapping Widgets.
  It also does not mention a third-party `keyguard` provider.
  <https://www.samsung.com/us/support/answer/ANS10000945/>
- Google’s Android Developers Blog, 6 March 2025, “Widgets on lock screen: FAQ”,
  says AOSP lock-screen widgets for tablets and phones start with the release
  after Android 16 (QPR1). It says all widgets are compatible unless the app
  opts out with category `not_keyguard` in an `xml-36` resource folder. It says
  the experience is about 4 by 3 launcher cells, the OEM chooses the trigger,
  and “Customization of the lock screen widget user interface by OEMs is not
  supported in the initial release.”
  <https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html>
- API 36 `AppWidgetProviderInfo.WIDGET_CATEGORY_NOT_KEYGUARD` says the widget
  should never be shown on the keyguard, including when a host offers widgets
  that never set `WIDGET_CATEGORY_KEYGUARD`. Setting the category does not
  change `AppWidgetManager` queries; the host surface has to respect it.
  <https://developer.android.com/reference/android/appwidget/AppWidgetProviderInfo>
- Samsung’s Flex Window code lab tells developers to combine
  `widgetCategory="keyguard"` with a second metadata resource,
  `com.samsung.android.appwidget.provider`, whose sample sets
  `display="sub_screen"`. The lab then enables that widget under **Settings →
  Cover screen → Widgets** on a Galaxy Z Flip5. That is the cover screen, not
  the phone lock-screen Brief picker.
  <https://developer.samsung.com/codelab/galaxy-z/widget-flex-window.html>
- Android’s widget layout guide, updated 22 October 2026, gives
  `targetCellWidth` / `targetCellHeight` for the default cell span and
  `maxResizeWidth` / `maxResizeHeight` in dp. It has no maximum-cell attribute.
  Its sample handset table is explicitly a Pixel 4 demonstration:
  portrait width `(73n − 16)` dp and height `(118m − 16)` dp, so 1 cell is
  57 dp wide, 4 cells are 276 dp, 5 cells are 349 dp, 2 rows are 220 dp, and
  3 rows are 337 dp. The same page says a widget can still be larger than
  `maxResizeWidth` × `maxResizeHeight`.
  <https://developer.android.com/develop/ui/views/appwidgets/layouts>
- Issue #102 records the owner’s report that no WhoopLens lock-screen widget
  was available on the Galaxy S26 Ultra. That report is the issue text, not a
  measurement taken for this change.
  <https://github.com/AStrasler/WHOOP-Lens/issues/102>

The platform resource qualifier for API 36 is `xml-v36`. The March 2025 FAQ
writes that folder as `xml-36`. This app uses `res/xml-v36/` so API 34 and 35
keep the older `home_screen` category and do not have to parse `not_keyguard`.

## Inference

Kept separate from the quotations above.

- Brief widgets, with a changing supported-app list and per-app style options,
  do not match the AOSP host Google described, where every widget is eligible
  and OEM customization of that UI was not part of the initial release.
  Declaring `widgetCategory="keyguard"` therefore does not register WhoopLens in
  Samsung’s Brief picker. The S26 Ultra report is consistent with that. This
  change did not re-check the phone.
- The Flex Window `sub_screen` metadata is for a cover display. Adding it on
  the S26 Ultra would invent a cover-screen integration. It is not used.
- `not_keyguard` asks an AOSP-style host to hide every WhoopLens provider.
  Whether One UI honors that flag is untested here. When this process updates a
  widget, it also withholds measurement text while the device is locked, the
  keyguard is showing, the display is off, or the host category is keyguard.
  `SCREEN_OFF` / `SCREEN_ON` are registered only while the process is alive, so
  a dead process cannot replace RemoteViews that were already published.

## What the app does

- Six home providers: default `1×1`, resize on both axes, minimum 40 dp,
  maximum hints 320×250 dp (between the published 4- and 5-column widths and
  the published 2- and 3-row heights on that sample grid).
- Picker preview layout `lens_widget_preview` shows the same em dash as an
  empty widget. It does not use a sample recovery, step, or sleep value.
  Placed widgets still use the responsive layouts and `OPTION_APPWIDGET_SIZES`.
- API 36 category is `home_screen|not_keyguard` for those six providers and for
  the status provider. No provider sets `keyguard` or `initialKeyguardLayout`.
- The old “Private lock-screen summary” label is now “WhoopLens status” and
  states that it shows no health measurements. The receiver remains so a widget
  that was already placed does not turn into a broken placeholder.
- Detailed home text is still explicit. Summary and Hidden stay non-numeric.
  Cached values are read only when the widget is not in a conceal state, and
  only for the signed-in account.

## Physical checklist

On the Galaxy S26 Ultra, with the already installed app. Do not uninstall it
and do not clear its data. Screenshots for this list must not include health
values; if a screen would show a number, describe it in words instead.

Record the Android version, security patch, One UI version, home-screen grid,
font scale, and display size before changing anything. Put the font scale and
display size back when finished.

Home screen, for Daily, Recovery, Steps, Sleep, Vitals, and Expanded:

1. Open the widget picker. Each WhoopLens entry should preview as about one
   cell, with an em dash and no sample measurement. If One UI still shows an
   old larger preview, remove that widget and add it again. Leave every other
   app and account in place.
2. Place each widget at the default size and write down the cell span.
3. Resize each one down to the smallest handle stop. The intended minimum is
   1×1. Write down the span the launcher actually allows.
4. Resize each one up. The intended maximum is 4×2. Write down the largest
   span. One UI may stop earlier, or it may allow a larger span, because the
   dp hints are not a cell cap. Try a second grid column count if the launcher
   offers one, using Expanded only.
5. At the current font size, and then at the largest font size, check the 1×1
   and the largest size for clipped text, overlap, and a value that no longer
   fits. Exact figures remain available to TalkBack.
6. Set widget privacy to Detailed and confirm the home widget shows a
   measurement. Lock the phone. The lock screen and Always On Display, if it
   is on, should not show that measurement. Unlock and confirm the home widget
   shows it again. Repeat once with Summary, which should stay non-numeric on
   the home screen too.
7. If a second account is already signed in on the phone, switch to it and
   confirm the previous account’s numbers are gone. Do not add an account and
   do not clear storage just for this step. If there is no second account,
   skip it.
8. Restart the phone. The same widgets should still be placed, still for the
   current account.
9. Tap a small widget and a large widget. Each tap should open WhoopLens.

Lock screen, as an observation rather than a feature check:

10. Open **Settings → Wallpaper and style → current lock screen → Add widgets**,
    and also press and hold the lock screen. Write down whether any WhoopLens
    entry appears. Absence is the result this investigation expects from
    Samsung’s supported-app list. Do not install Good Lock or LockStar to force
    a widget onto the lock screen and then treat that as stock One UI support.

Nothing in this file authorizes a new install, a merge, or a release.
