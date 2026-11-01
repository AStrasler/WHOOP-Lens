# Galaxy S26 Ultra — widget physical acceptance workstream

Status: **draft / hardware verification pending**. Converted from issue #102; the original issue's requirements and discussion remain attached to the pull request.

## Evidence baseline

Repository checks have already covered six responsive home widgets, picker resources, privacy/account isolation, metadata and emulator renders. The installed `0.3.0-beta.1` application reportedly preserved login, cache and Health Connect on the S26 Ultra. **Neither proves widget placement or Samsung lock-screen integration.**

Current `PrivateLockWidget` is a home-screen status widget, **not** evidence of a Samsung Brief/Now Bar lock-screen provider. The Android dp maximum size hint does **not** guarantee a 4×2 maximum in One UI.

References:
- `docs/android-widget-sizing.md`
- `docs/android-s26-ultra-widgets.md`
- `docs/android-companion.test.mjs`

## Physical-device acceptance record (owner-controlled)

Record the Android version, One UI build, installed app build, launcher grid and font scale before testing. Only claim passes when witnessed on an actual Galaxy S26 Ultra.

| Home widget | Picker size/preview | Placed 1×1 | Resized through 4×2 | Data/privacy/account state |
| --- | --- | --- | --- | --- |
| Daily | Untested | Untested | Untested | Untested |
| Recovery | Untested | Untested | Untested | Untested |
| Steps | Untested | Untested | Untested | Untested |
| Sleep | Untested | Untested | Untested | Untested |
| Vitals | Untested | Untested | Untested | Untested |
| Expanded | Untested | Untested | Untested | Untested |

- [ ] Compare picker preview vs actual cell footprint for all six widget providers.
- [ ] Test 1×1 and 4×2 extremes, resizing behavior, clipping, empty cells and One UI grid variations.
- [ ] Repeat at 100% and 200% system fonts.
- [ ] Verify refresh, locked/privacy states, account switch and reboot.
- [ ] Check Samsung **Settings → Wallpaper and style → Lock screen → Add widgets** and record the actual Brief-widget picker behavior.
- [ ] If WHOOP Lens is not supported by the Samsung host, describe this limitation accurately, without presenting a home status widget as a physical lock-screen widget.
- [ ] Record sanitized screenshots/results, not private health measurements.

## Gates

No new phone installation, release, data clearing or uninstall without owner authorization. Keep lock-screen Summary/Detailed modes unapproved pending evidence. Static tests and emulator passes never substitute for physical One UI verification. Independent review and green CI required before any code changes are merged.

**Do not mark this PR ready for merge or close acceptance before the hardware checks are documented.**
