# Background Direct BLE: security and lifecycle review (#100)

Status: engineering review complete; **new Android permissions await owner approval**. Nothing
here has been released or tested on a phone. Merging this PR adds the permissions to the next
APK, so approving the merge is approving these permissions.

## Permissions requested for approval

| Permission | Type | Why it is needed | What it does not allow |
| --- | --- | --- | --- |
| `android.permission.FOREGROUND_SERVICE` | Normal (install-time, no prompt) | Required for any app that runs a foreground service | No data access by itself |
| `android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE` | Normal (install-time, no prompt) | Android 14+ requires a declared service type. `connectedDevice` is the type for an ongoing link to a Bluetooth device. Android only lets this type start when the app already holds `BLUETOOTH_CONNECT` | Does not grant Bluetooth, location, health or network access. Not usable from the background or from boot |
| `android.permission.POST_NOTIFICATIONS` | Runtime (prompt, Android 13+) | Shows the ongoing session notification with the Stop action. Asked once, together with Nearby Devices, on the Direct BLE screen | Not used for any other notification. If declined, Direct BLE stays foreground-only (see below) |

Unchanged: `BLUETOOTH_SCAN` (with `neverForLocation`) and `BLUETOOTH_CONNECT`. Still absent:
location, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_ADMIN`, boot receivers, `WAKE_LOCK`, exact alarms,
and any health write permission. Tests enforce this list (`docs/android-ble.test.mjs`,
`docs/glass-overlap.test.mjs`, `BleTest.kt`); `scripts/android_release.py` still rejects any
other Bluetooth or location permission in a release APK.

## What was validated, and how

| Area | Behaviour | Evidence |
| --- | --- | --- |
| Starting | The service starts only when a session enters Connecting, which only an explicit Connect or Reconnect tap on the visible screen can cause. Never from boot, a schedule, a notification or another app (service `exported=false`) | `BleRuntime.syncService`; manifest test asserts one non-exported `connectedDevice` service and no boot receiver |
| Foreground to background | Leaving the screen or pausing ends scanning only. Pairing and permission dialogs (which only pause the app) no longer end a connection | `stopScan()` in `onPause`; `leavingTheScreenStopsOnlyScanningAndKeepsCandidates` |
| No invisible collection | When WhoopLens is no longer visible, a session continues only if its notification can be seen. If notifications are off or the channel is blocked, the session stops, as before this change. Swiping the notification away (allowed on Android 14+) stops the session. Blocking the Direct BLE channel or all WhoopLens notifications in Settings while the app is in the background also stops it: the service listens for Android's channel and app block-state broadcasts | `onStop` check with `BleRuntime.notificationVisible`; `setDeleteIntent(stop)`; block-state receiver in `BleSessionService`; `backgroundContinuationNeedsAVisibleNotification`, `blockingTheNotificationAfterBackgroundingEndsTheSession` |
| Termination | Stop (app or notification), notification dismissed, swiping WhoopLens from Recents (`onTaskRemoved`), two failed retries, Bluetooth off, permission revoked (Android also kills the process), sign-out or account change. `START_NOT_STICKY`: never restarted after process death | `BleSessionService`; `connectionTimeoutRetriesOnlyTwiceAndThenStops`, `bluetoothInterruptionStopsSession`, `signOutRejectsOldCallbacksAndClearsCredentials` |
| Reconnect limits | Reconnect is a member tap only, to the strap already selected in this process under the same account. It gives a fresh budget of two automatic retries; nothing reconnects on its own after that | `reconnect*` tests |
| Lock-screen privacy | The notification shows phase and the member-chosen strap label only, never heart rate, R-R, energy or contact. `VISIBILITY_PRIVATE` with a public version that says only "Direct BLE session active". Low importance, silent, no badge | `sessionNotificationNeverCarriesMeasurements`; manifest/runtime test forbids readings in `BleRuntime.kt` |
| Member isolation | Every GATT callback re-checks the signed-in account, permission and connection generation. An account change or sign-out clears the cache and selection, which also stops the service. Reconnect cannot carry a strap across accounts | `accountSwitchRejectsDelayedPacketAndErasesOldCache`, `reconnectCannotCarryAStrapAcrossAccounts` |
| Device authorization | Connection is only to a strap the member picked from this session's scan. The address is kept in memory only, never persisted or sent anywhere. OS pairing, if a strap requires it, stays Android's own dialog | `discoveryNeverConnectsWithoutExplicitKnownSelection` |
| No unintended collection, commands or uploads | Background adds no new data: the same standard HR (180D/2A37) notifications, the same single encrypted latest-reading snapshot (at most every 5 s). One descriptor write (the standard HR CCCD) in the whole app; no characteristic writes, no indications, no network code in BLE files, `ENABLE_UPLOADS` behaviour unchanged | `BleTest` source scan, `docs/android-ble.test.mjs` |
| Other apps | Notification intents are explicit and immutable. The activity accepts only the exact Direct BLE page extra, which navigates and does nothing else | `BleSessionService`, `MainActivity.openRequestedPage` |

## Battery and lifecycle implications

- A live session keeps a BLE connection and wakes the app for each heart-rate notification
  (typically about once a second) plus an encrypted write at most every 5 s. Expect battery use
  similar to other apps that stream from a heart-rate strap. It lasts only until the member
  stops it.
- No wake lock or alarm is held. Retry back-off (2 s, 4 s) and the 15 s connection timeout run
  on the main looper's uptime clock, so if the phone's CPU sleeps right after a disconnect,
  the retry or the stop can be delayed until the next wake. Android's own GATT timeouts still
  report failures, and nothing is collected while waiting. The notification may say
  "Reconnecting" during that time. Fixing it would need `WAKE_LOCK` or alarms, which this
  change deliberately does not request.
- Samsung's battery management ("Sleeping apps", "Deep sleeping apps") can stop background
  services. That needs checking on the S26 Ultra; it is in the physical checklist.
- Android 15's foreground-service time limits apply to `dataSync` and `mediaProcessing`, not
  `connectedDevice`.

## Physical checks still required (not done)

See `docs/workstreams/whoop-50-mg-physical-acceptance.md` → Background checks. In short: live
session through screen-off and app switch for 2+ minutes; lock-screen notification shows no
readings; Stop, notification swipe and Recents swipe each end it; notifications denied means it
stops when you leave; Reconnect works without a scan; Samsung battery settings don't silently
end it.
