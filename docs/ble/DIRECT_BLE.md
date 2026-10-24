# Direct WHOOP BLE: first implementation

Local branch: `codex/android-direct-ble-release`, based on PR #85's verified
`e833d93d9e01c5fffad6ee8d7d9f377885984da5` plus attribution commit
`2034715c124d3b787e0ec5f352605732bd71da58`, each included once. Neither existing
PR is modified or merged by this branch.

## What is implemented

Account & Settings -> Direct BLE opens a native LensUi screen. Nearby Devices
is requested only after Scan. A user-started 12-second scan retains at most 30
WHOOP service/name candidates; it never automatically selects one. Labels
distinguish observed 4.0 vs 5.0/MG service families from a name-only match. Model,
firmware and generation-specific measurement support remain unverified.

Explicit selection connects through Android GATT, discovers services, checks
standard Heart Rate Service `180D` / Measurement `2A37`, requires the notify
property and CCCD, and waits for a successful CCCD write before accepting data.
Connection/subscription has a 15-second timeout. Failures have at most two
automatic retries, delayed by two and four seconds, only during the active
foreground session. Missing HR/CCCD or subscription rejection is explicit.
There are no proprietary characteristic writes or device unlock commands.
Android controls any supported pairing/encryption requirement.

The MIT-adapted standard HR parser supports flag-dependent 8/16-bit HR,
optional sensor contact and energy (kJ counter), and optional R-R intervals.
Original R-R ticks (1/1024 second) are retained alongside milliseconds. Empty,
truncated, inconsistent/reserved flags, zero/unavailable BPM/R-R and oversized
packets are rejected. No missing value becomes zero. A 16-bit protocol value is
not silently capped to a guessed physiological range.

Live observations are labelled **WHOOP Direct BLE** and carry phone receipt
wall time plus monotonic receipt time. Standard packets have no absolute sensor
clock; receipt time is never represented as a device timestamp. Values older
than 15 seconds are stale. A reconnect does not make a saved observation live.

`direct-ble.bin` in `noBackupFilesDir` uses a dedicated Android Keystore alias
`whooplens.direct-ble.v1`, AES-GCM, authenticated BLE-specific binding and atomic
writes through existing encryption primitives. It retains one bounded latest
packet/snapshot, written at most once per five seconds (first valid reading
immediately). Sudden process death may therefore leave a saved observation up
to five seconds behind; it is always shown as saved after restart.

Leaving Direct BLE, pausing/locking/backgrounding the app or user Stop cancels
scan/retry timers, closes GATT and rejects old connection callbacks. Logout and
account change additionally clear BLE cache and revoke the local device/session
selection. Every callback checks account, permission and connection generation.
Offline BLE uses the existing locally selected signed-in account; it never
creates a parallel login or exports tokens over Bluetooth.

Official WHOOP API and Health Connect models/cache/widget routing remain
unchanged. BLE does not enter their two-source enum. No Bluetooth background
service, WorkManager BLE collection, cloud upload, health deletion, history
drain/ACK, trim/read-pointer change, clock write, firmware operation or new
third-party runtime library is added. Official WHOOP requests retain their
existing OAuth/membership checks. Existing dashboard background refresh remains.

## Attribution

Only `whoop4-ble/reader.py::parse_hr_measurement` is adapted, under its pinned
MIT grant; full notice is packaged in APK assets. The other three forks are
active engineering references, not copied implementations. See
[upstream provenance](upstream-provenance.md), [credits](UPSTREAM_CREDITS.md) and
[third-party notices](../../THIRD_PARTY_NOTICES.md). Account & Settings includes
offline Open Source Licenses & Credits, including existing font notices.

## Local verification commands

```text
gradlew.bat -p <Android build copy> testDebugUnitTest lintDebug assembleDebug assembleRelease --offline --no-daemon
gradlew.bat -p <Android build copy> assembleDebugAndroidTest -PlensTestRunner=io.github.astrasler.whooplens.BleReviewInstrumentation --offline --no-daemon
adb -s emulator-5554 shell am instrument -w io.github.astrasler.whooplens.test/io.github.astrasler.whooplens.BleReviewInstrumentation
node --test docs/*.test.mjs supabase/functions/tests/*.test.mjs site/build.test.mjs cloudflare/test/*.test.mjs cloudflare/test/provider/*.test.mjs
python -m unittest discover -s scripts -p test_android_release.py
python scripts/android_release.py apk --apk <signed APK> --build-tools <SDK build-tools/36.0.0> --version 0.3.0-beta.1 --code 5
git diff --check
```

On PowerShell quote the whole `-PlensTestRunner=...` argument. The default test
runner remains DesignReviewInstrumentation. BLE instrumentation uses a separate
test APK with synthetic native UI states and a real emulator Keystore; no
fixture or authentication bypass is packaged in the companion. It does not
validate RF, real GATT interoperability or a physical WHOOP.

## Samsung Galaxy S26 Ultra / actual strap checklist

Installation requires separate owner approval. Do not uninstall, clear data,
reset the strap, unpair existing devices, or send speculative control commands.

1. Record strap generation, model and exact firmware, Samsung/Android version,
   and supported HR-broadcast setting. No 4.0/5.0/MG support is marked physically
   verified by this implementation yet.
2. Verify package, increasing versionCode and the established certificate before
   installing over the existing app. Confirm OAuth session, settings, Health
   Connect grants and saved dashboards remain. Restart without signing out.
3. Open Settings -> Direct BLE -> Scan; grant Nearby Devices. Check timeout,
   candidate details and explicit selection, including two nearby devices if
   available. No automatic connection is acceptable.
4. Confirm standard HR service/notify/CCCD availability. If absent, record
   unsupported; enable only a documented supported broadcast control if
   available. No custom unlock is attempted.
5. Observe actual HR and compare a contemporaneous trusted reading. Confirm
   source and receipt timestamp. R-R may be absent; do not fabricate it.
6. Test Stop, unexpected disconnect, two-retry limit, Bluetooth off/on, permission
   revocation, navigation away, screen lock and app exit. No background BLE
   notifications/collection should persist. Reconnection requires an active
   session or a new manual action.
7. Test offline operation and freshness after 15 seconds without packets. Test
   app/process restart: saved observations must not say Live.
8. Switch/logout accounts during scan, connection and streaming. Old candidates,
   callbacks and samples must never appear under another account.
9. Check official WHOOP, Health Connect, existing widgets and background dashboard
   refresh still operate; uploads/deletion remain disabled. Check battery/heat
   during a bounded session. Inspect diagnostics only after explicit consent;
   do not publish raw packets, device addresses or personal measurements.

Future proprietary decoding, locally computed estimates and continuous BLE
background collection are separate capabilities needing actual hardware evidence,
license review of any selected component and a new scope decision.
