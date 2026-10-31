# Native glass refinements

The HRV/RHR personal-baseline cards, liquid buttons and icon-led drawer are integrated with main's Overview cards, recorded chart points, freshness labels and Home controls. Overview compares prior records; HRV/RHR explicitly compare a personal baseline. Neither arrow implies health improvement.

Recovery uses a separate details button so nested HRV/RHR controls stay independently reachable. Stat cards expose one button role and one complete accessible name; decorative children are hidden from accessibility. Font scaling above 130% stacks the cards. Touch targets are at least 48dp. Lift effects are suppressed for remove-animations, reduced transparency and battery saver.

## Automated and owner verification

Android CI runs unit tests, lint, debug build and instrumentation compilation. The API 34/36 emulator job produces 18 synthetic component screenshots per API: 360/412/480dp widths, 100%/200% fonts, and three appearances. It checks text fit, independent taps, touch targets, accessible roles, contrast and remove-animations. These are representative density-independent phone widths; they do not assert the actual Galaxy S26 Ultra display mode, One UI behavior or physical-device approval.

Download `android-debug-owner-testing` and `glassy-evidence-api-*` from the PR's Android Actions run. The debug APK is for separately approved owner testing, not a production release. On the Galaxy S26 Ultra record the actual resolution, display zoom and Android/One UI version; check normal and 200% font scale, Home HRV/RHR details, recovery details, drawer selection, TalkBack navigation, contrast, pointer/press feedback, remove-animations and battery saver. Do not uninstall the existing app or overwrite a signed release without owner approval. Physical acceptance remains outstanding until those results are supplied.
