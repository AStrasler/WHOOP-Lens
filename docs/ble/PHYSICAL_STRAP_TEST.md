# Physical strap test: WHOOP 5.0 and WHOOP MG

This procedure has not been run. No result in this repository is hardware-tested.
An emulator, a unit test, or a synthetic frame cannot fill a cell in either sheet.

Run Sheet A on a WHOOP 5.0 strap and Sheet B on a WHOOP MG strap. Do not copy a
result from one sheet to the other. WHOOP 4.0 is out of scope for these two
sheets; if a candidate is labeled as the 4.0 service, stop that sheet and record
the label.

The shared session safeguards from [DIRECT_BLE.md](DIRECT_BLE.md) still apply:
foreground only, explicit selection, no background collection, account isolation,
and no cloud upload. This file adds the generation record those steps did not
split.

## Safeguards for both sheets

Do not uninstall the app, clear its data, reset the strap, unpair it, or power-cycle
the strap. Do not send a proprietary command, hello, clock write, history read,
history acknowledgement, trim, haptic, alarm, device-config write, or firmware
operation. The app has no control that sends those. If any build offers one,
stop and record the control's exact label.

Do not type a command from a public write-up into a BLE tool during this test.
In particular, do not write the published 5.0/MG hello, do not write command
`0x91`, and do not acknowledge historical data. An acknowledgement can move the
strap's read pointer.

Read generation, model and firmware from the official WHOOP app's device screen
when it shows them. Do not unpair that app to make this app connect. If the
strap will not connect while the official app holds it, record the failure and
stop the sheet.

Confirm the install is the build the owner approved. Record `versionName` and
`versionCode` from the system App info screen. Do not change them for this test.

Permissions must be exactly Nearby Devices: `BLUETOOTH_SCAN` and
`BLUETOOTH_CONNECT`. The scan request must not ask for location. If Android asks
for location, stop and record the permission dialog text. That is a safeguard
failure, not a strap result.

## Record before either sheet

Fill this in once, on paper or a private note. Do not put the strap address,
raw packets, or heart-rate values into a git commit.

- Phone model, Android version, One UI version.
- App versionName and versionCode.
- WHOOP account subscription state, as shown in the official app, without
  changing it. "Active" and "not active" are both just the state during the
  test. Neither one proves that a subscription is or is not required.
- Which physical strap will be used for Sheet A, and which for Sheet B. If only
  one strap is in the room, run only that sheet.

## Sheet A — WHOOP 5.0

1. Confirm the strap in hand is the 5.0, using the official app's device screen
   and the body of the strap. Write "Sheet A, WHOOP 5.0" and the model and
   firmware strings exactly as shown. If the official app does not show a
   generation, write "generation not shown" and do not infer 5.0 from this
   app's label.
2. Open WhoopLens, Account & Settings, Direct BLE. Leave the screen in the
   foreground for the whole sheet.
3. Tap Scan. Grant Nearby Devices if asked. Wait for the 12-second scan to
   finish. The app must not connect by itself.
4. Record every candidate's name, the full family label, and the last five
   characters of the address. The expected label, if the cited public family is
   what this strap advertises, is `fd4b0001 shared by 5.0 and MG. Product
   unverified.` A 4.0 label means this is not the Sheet A strap; stop. A
   name-only label means the custom service was not in the advertisement;
   record that and stop without connecting.
5. If more than one candidate appears, connect only to the strap identified in
   step 1. Record that the others were not selected.
6. Record the connection result within the 15-second budget:
   - If it fails, record the exact message. Do not retry by any tool other than
     the app's own two automatic retries. Then stop this sheet.
   - If it reaches Subscribed, copy the details line exactly. It must say
     standard HR `180D` / `2A37` and CCCD confirmed, and it must include the
     shared-family label. Record the `2A37`, `2A19`, `fd4b0007` and `180A` yes/no
     fields and the `services=` list.
7. Watch for 30 seconds.
   - If a BPM appears, record the BPM, whether R-R says "not supplied" or lists
     ticks, the source line, and the "Received on this phone" line. Compare the
     BPM with one contemporaneous reading you trust (a counted pulse, or the
     official app if it is already showing heart rate). Record match or
     mismatch. Do not invent R-R ticks.
   - If no BPM appears, record "no 2A37 notification in 30 seconds". That is a
     completed observation, including if it matches the public report that MG
     and 5.0 do not use the standard Heart Rate service. Do not turn on a
     broadcast setting unless it is a documented control in the official app
     that you can identify without sending a command from WhoopLens. If you
     cannot find one, write "broadcast control not found" and leave the strap
     as it is.
8. Tap Stop. Confirm the phase leaves Live and the saved reading is not labeled
   Live. Lock the phone for 10 seconds, unlock, and confirm WhoopLens is not
   still notifying or reconnecting. Bluetooth notification collection must
   require the Direct BLE screen to be open again.
9. Mark only the cells you actually observed. A shared-family label supports
   "this 5.0 strap advertised `fd4b0001`". It does not identify the product as
   distinct from MG, and it does not transfer to Sheet B.

## Sheet B — WHOOP MG

Repeat steps 1 through 9 with the MG strap. Write "Sheet B, WHOOP MG" at the
top. Use the same expected label and the same rule that the label does not
prove the product. Do not reuse Sheet A's BPM, service list, or pass/fail.

The useful comparison is the difference, if any, between the two recorded
details lines: advertised label, service prefixes, `2A37`/`2A19`/`fd4b0007`/`180A`,
and whether a standard heart-rate notification arrived. Identical lines support
the public claim that the service family is shared. They are not a finding that
the two products are the same device, and they are not an ECG or skin-temperature
result. Those paths are not implemented and must not be probed.

## After at least one sheet has connected or failed cleanly

Run the account and regression checks from DIRECT_BLE.md steps 6 through 9 once
on this phone: stop, Bluetooth off, permission revoked, leave the screen, saved
readings not shown as Live, account switch during scan, and official WHOOP /
Health Connect still unchanged. If neither strap exposes standard heart-rate
notifications, the live-BPM parts of those steps are blocked; record that, and
still run the scan, stop, permission, and account-switch checks.

## What may be written down as hardware-tested

Only a behavior observed on that sheet's strap, with the generation, model,
firmware, phone and subscription state written beside it. Examples that qualify
when they actually happen: "this 5.0 strap's advertisement was classified with
the shared `fd4b0001` label"; "this MG strap did not send a `2A37` notification
in 30 seconds"; "this MG strap's details line showed `fd4b0007=yes`".

## What this procedure must not mark

- The other generation.
- Subscription-free operation, in either direction.
- ECG, skin temperature, historical heart rate, strain, recovery, or sleep.
- Any command the procedure forbids.
- A result from a unit test, emulator, or this document.
