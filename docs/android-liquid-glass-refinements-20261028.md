# Android liquid-glass refinements — October 28, 2026

The owner supplied three visual references: glassy dashboard stat cards, an illuminated translucent sidebar, and raised liquid-pill buttons. The video fragments use React, Framer Motion and Lucide; the WhoopLens Android companion is a native Kotlin Views app, so the visual behavior is implemented natively without adding those web libraries.

## Changes

- `LensUi.button`: rounded, gradient-highlighted liquid buttons; native ripple, disabled-state contrast, minimum 48dp touch target.
- `LensUi.statsCard`: frosted title/value/icon/trend tiles with a user-interaction-only 5dp lift, preserving screen-reader names and normal tap handling.
- The home recovery section shows actual WHOOP HRV and resting-HR values. Percentages appear only when a valid personal baseline is available; arrows mean higher/lower, **not** healthier/unhealthier. Missing history displays a clear unavailable state.
- The existing blurred navigation drawer gains an icon-led, selected-page treatment without new routes or API behavior.
- No perpetual animation. Motion is disabled for reduced-motion and battery-saver appearances.

## Scope and privacy

Only native UI code and a pure display-formatting test changed. No API endpoints, storage, OAuth, Health Connect ingestion, token handling, lock-screen privacy defaults or releases were changed.

## Verification

- Pure `baselinePercent` unit cases were added for positive, negative, zero, missing and non-finite values.
- **Requires CI:** `gradle -p android :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`.
- **Requires owner device check:** Galaxy S26 Ultra typography at 200%, inset and nested-card readability, nav selection, pointer/press animations, reduced-motion and battery-saver behavior.
- The reference screenshots and original React snippet are visual guidance only; this PR does not claim exact source reconstruction.
