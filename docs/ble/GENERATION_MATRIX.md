# WHOOP generation compatibility matrix

Issue #100. This matrix compares WHOOP 4.0, WHOOP 5.0 and WHOOP MG as separate
targets. 4.0 is included because the public service families are how a scan
tells that family from the later one. 5.0 and MG are equal rows. No row is a
hardware result. Unit tests and the synthetic frames below are not a strap, an
emulator radio, or a subscription-free demonstration.

The executable copy is `GenerationMatrix` in
`android/app/src/main/java/io/github/astrasler/whooplens/ble/StrapCompatibility.kt`.
The table between the markers is that object rendered. A unit test fails if the
two diverge.

## How to read a cell

- **completed code** — implemented in this source. It does not mean a strap was contacted. Parsers with no GATT caller are still completed code, and the matrix says when they are not wired.
- **simulated or unit-tested** — covered by a synthetic packet, a fake transport,
  or a source check. Not a radio.
- **pending physical verification** — needs the procedure in
  [PHYSICAL_STRAP_TEST.md](PHYSICAL_STRAP_TEST.md), run separately on a 5.0
  strap and on an MG strap.

A cell can carry more than one mark. None of the marks means hardware-tested.

## What the public sources actually separate

| Question | Public evidence used here | What this app does with it |
|---|---|---|
| 4.0 vs later straps | whoop4-ble `docs/PROTOCOL.md` at `a76ad457` (MIT) and NOOP `docs/PROTOCOL.md` at `7be90e0`: custom service `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` versus `fd4b0001-cce1-4033-93ce-002d5875f58a`. | Advertisement classification. Pending a real scan. |
| 5.0 vs MG | NOOP documents one `fd4b0001` family for "WHOOP 5.0 / MG", including `fd4b0007`. Vestigator part 7 (Zë Stuart, 25 Jun 2026, https://zulusierra.co/vestigator-part-7-mg-protocol/) says Goose (5.0) and Maverick (MG) share that stack, and that ECG and skin temperature are MG paths selected in software. No cited source gives a read-only UUID or model string that proves one product. | The label stays "shared by 5.0 and MG". Device-information text is not mapped. `fd4b0007` does not select either product. |
| Live standard heart rate | whoop4-ble: `180D`/`2A37` on that author's 4.0, described as working without a subscription. NOOP: `180D`/`2A37` and `180F`/`2A19` on both generations, unbonded. Vestigator part 7: on the MG session, per-second heart rate was historical replay on `fd4b0005`, and the standard Heart Rate service was not that path. | The standard parser is implemented. Whether 5.0 or MG notifies `2A37` is unresolved. This app still only writes the standard HR CCCD, and only when `2A37` exposes notify. |
| Proprietary commands | Both layouts describe command writes, history ack/trim, and clock writes. Vestigator's MG hello is command `0x91` on the 8-byte envelope. whoop4-ble describes 4.0 clock and trim behavior, including pointer side effects. | Not implemented. The procedure forbids sending them. The published hello bytes are not in the source. |

## Protocol differences encoded in the recognizer

These checks are not connected to a GATT callback. The app neither receives nor transmits these frames. The unit-test frames are synthetic, not captures.

WHOOP 4.0, from the MIT protocol note: `AA`, little-endian length, CRC-8
(poly `0x07`, init `0`) over those two length bytes, inner bytes starting at
offset 4, CRC-32 (zlib) over the inner bytes, total size = length + 4.

WHOOP 5.0 and MG, from the pinned NOOP protocol note: `AA`, format `01`,
little-endian declared length, two header bytes, CRC-16-Modbus (poly `0xA001`,
init `0xFFFF`) over the first six bytes, inner bytes at offset 8, CRC-32 over
that inner span, total size = declared length + 8. A valid result is
`SHARED_5_0_OR_MG`, never 5.0 alone and never MG alone.

The synthetic frames in `BleTest` were calculated from those rules. They are
not captures. Battery Level follows the Bluetooth SIG uint8 percent range
0–100; 0 is a real empty reading and 101–255 is rejected. No battery read is
connected to GATT.

## Matrix

<!-- matrix-start -->
| Generation | Topic | Evidence | Finding |
|---|---|---|---|
| WHOOP 4.0 | advertised custom service | completed code; simulated or unit-tested; pending physical verification | Classifier maps 61080001-8d6d-82b8-614a-1c8cb0f8dcc6 to the 4.0 family. No strap has been scanned. |
| WHOOP 5.0 | advertised custom service | completed code; simulated or unit-tested; pending physical verification | Classifier maps fd4b0001-cce1-4033-93ce-002d5875f58a to the shared family, not to 5.0 alone. No strap has been scanned. |
| WHOOP MG | advertised custom service | completed code; simulated or unit-tested; pending physical verification | Classifier maps fd4b0001-cce1-4033-93ce-002d5875f58a to the shared family, not to MG alone. No strap has been scanned. |
| WHOOP 4.0 | custom characteristics | completed code; simulated or unit-tested; pending physical verification | GATT inventory can record 61080002 through 61080005. None of them is written. |
| WHOOP 5.0 | custom characteristics | completed code; simulated or unit-tested; pending physical verification | GATT inventory can record fd4b0002 through fd4b0005 and fd4b0007. fd4b0007 does not select 5.0. None is written. |
| WHOOP MG | custom characteristics | completed code; simulated or unit-tested; pending physical verification | GATT inventory can record fd4b0002 through fd4b0005 and fd4b0007. fd4b0007 does not select MG. None is written. |
| WHOOP 4.0 | standard heart-rate parser | completed code; simulated or unit-tested | Bluetooth Heart Rate Measurement parser, synthetic packets only. Not evidence that a 4.0 strap notifies. |
| WHOOP 5.0 | standard heart-rate parser | completed code; simulated or unit-tested | Same parser. Not evidence that a 5.0 strap notifies. |
| WHOOP MG | standard heart-rate parser | completed code; simulated or unit-tested | Same parser. Not evidence that an MG strap notifies. |
| WHOOP 4.0 | standard heart-rate notifications on a strap | pending physical verification | whoop4-ble reports live 180D/2A37 on that author's 4.0. WHOOP Lens has not confirmed it. |
| WHOOP 5.0 | standard heart-rate notifications on a strap | pending physical verification | NOOP claims unbonded 180D/2A37. Vestigator part 7 saw that fail on an MG, not on a cited 5.0. Unresolved for 5.0. |
| WHOOP MG | standard heart-rate notifications on a strap | pending physical verification | Same public conflict. Vestigator's session was an MG. Unresolved for MG until that strap is tested. |
| WHOOP 4.0 | optional R-R intervals | completed code; simulated or unit-tested; pending physical verification | Parser keeps 1/1024 s ticks when the standard flag is set. Whether a 4.0 strap sets it is unverified. |
| WHOOP 5.0 | optional R-R intervals | completed code; simulated or unit-tested; pending physical verification | No 5.0 capture in this repo shows 2A37 R-R. Absence must stay absent. |
| WHOOP MG | optional R-R intervals | completed code; simulated or unit-tested; pending physical verification | No MG capture in this repo shows 2A37 R-R. Absence must stay absent. |
| WHOOP 4.0 | standard battery parser | completed code; simulated or unit-tested | SIG Battery Level parser: one byte, 0 through 100. No live read is wired. |
| WHOOP 5.0 | standard battery parser | completed code; simulated or unit-tested | Same parser. No live read is wired, and a 5.0 battery value has not been read. |
| WHOOP MG | standard battery parser | completed code; simulated or unit-tested | Same parser. No live read is wired, and an MG battery value has not been read. |
| WHOOP 4.0 | battery level on a strap | pending physical verification | NOOP claims 180F/2A19 on 4.0. This app does not read it. Confirm without writing. |
| WHOOP 5.0 | battery level on a strap | pending physical verification | NOOP claims 2A19 on the shared family. Confirm on a 5.0 strap without writing. |
| WHOOP MG | battery level on a strap | pending physical verification | NOOP claims 2A19 on the shared family. Confirm on an MG strap without writing. |
| WHOOP 4.0 | frame envelope recognizer | completed code; simulated or unit-tested | Independent check of the published 4.0 envelope on a synthetic frame. Not a captured strap frame. |
| WHOOP 5.0 | frame envelope recognizer | completed code; simulated or unit-tested | Independent check of the published 8-byte envelope. A match is not identified as 5.0 rather than MG. |
| WHOOP MG | frame envelope recognizer | completed code; simulated or unit-tested | Same recognizer. A match is the shared envelope, not an MG identification. |
| WHOOP 4.0 | service UUID identifies this product alone | completed code; simulated or unit-tested; pending physical verification | 61080001 selects the 4.0 family label only. That is not a physical identification. |
| WHOOP 5.0 | service UUID identifies this product alone | completed code; simulated or unit-tested; pending physical verification | fd4b0001 does not identify WHOOP 5.0 alone. The label stays shared. |
| WHOOP MG | service UUID identifies this product alone | completed code; simulated or unit-tested; pending physical verification | fd4b0001 does not identify WHOOP MG alone. The label stays shared. |
| WHOOP 4.0 | device-information text selects this product | completed code; simulated or unit-tested; pending physical verification | Printable device-information bytes are not mapped to 4.0, 5.0 or MG. |
| WHOOP 5.0 | device-information text selects this product | completed code; simulated or unit-tested; pending physical verification | A model string containing 5.0 does not select WHOOP 5.0. |
| WHOOP MG | device-information text selects this product | completed code; simulated or unit-tested; pending physical verification | A model string containing MG does not select WHOOP MG. |
| WHOOP 4.0 | proprietary command write | pending physical verification | Command characteristics are inventory-only. Not implemented. The physical procedure must not send this. |
| WHOOP 5.0 | proprietary command write | pending physical verification | Command characteristics are inventory-only. Not implemented. The physical procedure must not send this. |
| WHOOP MG | proprietary command write | pending physical verification | Command characteristics are inventory-only. Not implemented. The physical procedure must not send this. |
| WHOOP 4.0 | history ack or trim | pending physical verification | History read, ack and trim are not implemented. The physical procedure must not send this. |
| WHOOP 5.0 | history ack or trim | pending physical verification | History read, ack and trim are not implemented. The physical procedure must not send this. |
| WHOOP MG | history ack or trim | pending physical verification | History read, ack and trim are not implemented. The physical procedure must not send this. |
| WHOOP 4.0 | clock write | pending physical verification | Clock writes are not implemented. The physical procedure must not send this. |
| WHOOP 5.0 | clock write | pending physical verification | Clock writes are not implemented. The physical procedure must not send this. |
| WHOOP MG | clock write | pending physical verification | Clock writes are not implemented. The physical procedure must not send this. |
| WHOOP 4.0 | firmware operation | pending physical verification | Firmware operations are not implemented. The physical procedure must not send this. |
| WHOOP 5.0 | firmware operation | pending physical verification | Firmware operations are not implemented. The physical procedure must not send this. |
| WHOOP MG | firmware operation | pending physical verification | Firmware operations are not implemented. The physical procedure must not send this. |
| WHOOP 4.0 | ECG | pending physical verification | Cited sources do not assign ECG to 4.0. Not implemented. The physical procedure must not probe it. |
| WHOOP 5.0 | ECG | pending physical verification | Vestigator describes ECG as an MG path. Not implemented. The physical procedure must not probe it. |
| WHOOP MG | ECG | pending physical verification | Described only through device-config commands. Not implemented. The physical procedure must not probe it. |
| WHOOP 4.0 | skin temperature | pending physical verification | whoop4-ble describes temperature inside historical records. Not implemented. The physical procedure must not send this. |
| WHOOP 5.0 | skin temperature | pending physical verification | Vestigator describes skin temperature as an MG path. Not implemented. The physical procedure must not probe it. |
| WHOOP MG | skin temperature | pending physical verification | Described as an MG sensor path. Not implemented. The physical procedure must not probe it. |
| WHOOP 4.0 | subscription required | pending physical verification | Not determined. There is no WHOOP Lens strap session, subscribed or otherwise. |
| WHOOP 5.0 | subscription required | pending physical verification | Not determined for 5.0. A subscribed session would not prove a subscription is required. |
| WHOOP MG | subscription required | pending physical verification | Not determined for MG. A subscribed session would not prove a subscription is required. |
| WHOOP 4.0 | app write surface | completed code; simulated or unit-tested; pending physical verification | Foreground transport still writes only the standard Heart Rate CCCD after 2A37 exposes notify. No new write was added. Acceptance on a 4.0 strap is unverified here. |
| WHOOP 5.0 | app write surface | completed code; simulated or unit-tested; pending physical verification | Same write surface. Whether a 5.0 strap accepts that CCCD is unverified. |
| WHOOP MG | app write surface | completed code; simulated or unit-tested; pending physical verification | Same write surface. Whether an MG strap accepts that CCCD is unverified. |
<!-- matrix-end -->

## Not decided

Subscription-free use is not decided. Official WHOOP and Health Connect metrics
stay on their existing paths. Direct BLE readings stay labeled WHOOP Direct BLE.
Cloud upload of raw wearable data stays off.
