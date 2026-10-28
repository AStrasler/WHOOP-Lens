# BLE component provenance

This implementation uses all four pinned forks as engineering references, while
incorporating only the narrowly selected MIT standard-HR parser. No unlicensed
transport, schema, decoder or fixture is translated or copied.

| Origin / maintainer | Exact revision | Original paths | WHOOP Lens destination | Usage / modifications / permission |
|---|---|---|---|---|
| [andyguzmaneth/whoop4-ble](https://github.com/andyguzmaneth/whoop4-ble), Andy Guzman; [fork](https://github.com/AStrasler/whoop4-ble) | `a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88` | `src/whoop4/reader.py::parse_hr_measurement` | `android/app/src/main/java/io/github/astrasler/whooplens/ble/BleModels.kt::HeartRateMeasurement.decode` | Adapted from Python to Kotlin; bounds/flags checks, typed contact/energy, raw R-R ticks and explicit conversion. MIT, Copyright (c) 2026 Andy Guzman. Full notice retained in APK assets and THIRD_PARTY_NOTICES.md. Approved scope under the local implementation assignment; no inherited custom-protocol code incorporated. |
| Same project | Same revision | `scan.py`, `packet.py`, `drain.py`, `docs/{STATUS,SAMPLE_SESSION,PROTOCOL}.md` | No copied code | Research only: 4.0 evidence, standard HR, limitations, clock/trim side effects; excludes speculative sensor guesses and unchecked frame parsing. |
| [muftiarfan/noop](https://github.com/muftiarfan/noop), upstream account muftiarfan / recorded author NoopApp; [fork](https://github.com/AStrasler/noop) | `7be90e0af86ba2c6545dbf7d051bacd370350c67` | `android/.../ble/WhoopBleClient.kt`, `android/.../protocol/{DeviceFamily,Framing}.kt`, protocol tests | No copied code | Research only: GATT sequencing, generation-vs-capability distinction, bounded collection/reconnect pitfalls. No applicable reuse grant found; copying blocked. |
| [johnmiddleton12/wearable](https://github.com/johnmiddleton12/wearable), Johnathan Middleton recorded author; [fork](https://github.com/AStrasler/wearable) | `890e0c96beb817ab0cec3aaf7d9a06c530025355` | `ios/OpenWhoop/BLE/{BLEManager,StandardHeartRate}.swift`, tests, `FINDINGS.md` | No copied code | Research only: standard/custom channel distinction, reassembly/history side effects, stale session/lifecycle constraints. No applicable reuse grant found; copying blocked. |
| [b-nnett/goose](https://github.com/b-nnett/goose), recorded author bennett; [fork](https://github.com/AStrasler/goose) | `ba9ae0280c9b5b9a1545baab8e944cb3b7563c62` | `GooseSwift/GooseBLEClient*`, `Rust/core/src/{protocol,openwhoop_reference}.rs`, fixture metadata/tests | No copied code | Research only: 5.0 UUID family, partial decoder limits and synthetic-vs-physical evidence. Core UNLICENSED; no code/fixtures copied. MG remains unverified. |

`AndroidBleTransport`, `BleSessionController`, `BleCache`, `AndroidBleStorage` and
the Direct BLE screen are WHOOP Lens implementations. UUID/protocol facts do not
justify copying another project's implementation. Tests use newly authored
synthetic standard-profile packets and injectable fake transports, not upstream
golden fixtures. `StrapChecksum`, `StrapEnvelope`, `BatteryLevelMeasurement` and
`StrapObservation` are the same kind of independent code: public layout facts
only, with synthetic frames computed for the tests. They do not include NOOP,
Wearable or Goose source, schemas, captured packets, or the published
`CLIENT_HELLO` command. The existing WHOOP/Health Connect source enum, dashboard
codec, widget routing and official API security remain separate from BLE
observations.

No upstream repository or fork source was modified. No new upstream dependency
is imported: the selected function adaptation uses Kotlin and platform APIs
already available. Complete MIT text and original copyright are packaged;
material modifications are identified in the source header and notices. The
research inventory preserves earlier contributor acknowledgments and unresolved
rights for unselected components. Do not imply endorsement or ownership transfer.
