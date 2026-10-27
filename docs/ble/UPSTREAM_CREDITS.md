# WHOOP BLE research references and upstream credits

Recorded 2026-10-24; updated for the local Direct BLE implementation. All four
projects remain research references. The standard-HR parser from whoop4-ble is
now additionally adapted under MIT; NOOP, Wearable and Goose remain research-only.
See [current source-to-destination mapping](upstream-provenance.md) and
[incorporated component notices](../../THIRD_PARTY_NOTICES.md). Creating a GitHub
fork does not supply a missing license or expand an existing permission grant.

Thank you to the original maintainers and contributors for their protocol and
interoperability research. They do not thereby endorse, maintain, sponsor or
support WHOOP Lens. Ownership of their work is not transferred by these forks.
WHOOP Lens's license must not be presented as relicensing their work.

## Pinned upstreams and native forks

These are the exact revisions used in the research, not moving branch aliases.
The native forks initially match these revisions. Future fork changes must be
identified separately rather than attributed to upstream developers.

| Project | Upstream maintainer / verified commit author | Original repository | AStrasler native fork | Research revision |
|---|---|---|---|---|
| NOOP | `muftiarfan` upstream account; available commits authored by `NoopApp`. Legal copyright ownership of all inherited work is not established. | [muftiarfan/noop](https://github.com/muftiarfan/noop) | [AStrasler/noop](https://github.com/AStrasler/noop) | `7be90e0af86ba2c6545dbf7d051bacd370350c67` |
| Wearable | `johnmiddleton12` upstream account; available commit authored by Johnathan Middleton. Ownership of disclosed ports is not established by that author name. | [johnmiddleton12/wearable](https://github.com/johnmiddleton12/wearable) | [AStrasler/wearable](https://github.com/AStrasler/wearable) | `890e0c96beb817ab0cec3aaf7d9a06c530025355` |
| Goose | `b-nnett` upstream account; available commits authored by `bennett`. A full legal copyright identity is not inferred. | [b-nnett/goose](https://github.com/b-nnett/goose) | [AStrasler/goose](https://github.com/AStrasler/goose) | `ba9ae0280c9b5b9a1545baab8e944cb3b7563c62` |
| whoop4-ble | `andyguzmaneth` upstream account; Andy Guzman is named in package metadata, commit history and the copyright notice. | [andyguzmaneth/whoop4-ble](https://github.com/andyguzmaneth/whoop4-ble) | [AStrasler/whoop4-ble](https://github.com/AStrasler/whoop4-ble) | `a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88` |

Credit extends to identifiable contributors and earlier work acknowledged by
each upstream, not just the current repository owner. The original histories,
acknowledgments, headers and notices remain authoritative. Do not replace or
rewrite them with WHOOP Lens authorship.

## License findings and reuse boundaries

| Project | Verified license information at the pinned revision | Current usage / incorporation decision |
|---|---|---|
| NOOP | No root license/notice granting redistribution or adaptation was found in the tracked tree. The inspected transport/protocol files do not supply an applicable permissive grant. Existing `ATTRIBUTION.md` and `DISCLAIMER.md` must be retained. | Research-only. Copying/adapting its source, schemas or fixtures is not cleared. Obtain an appropriate grant and resolve inherited provenance before incorporation. |
| Wearable | No root license/notice granting redistribution or adaptation was found. README descriptions such as original work or open source do not replace a license grant. Retain `DISCLAIMER.md` and existing credits. | Research-only. Code, schemas, fixtures and disclosed ports are not cleared for incorporation. |
| Goose | No root redistribution grant was found. [`Rust/core/Cargo.toml`](https://github.com/b-nnett/goose/blob/ba9ae0280c9b5b9a1545baab8e944cb3b7563c62/Rust/core/Cargo.toml) explicitly declares `license = "UNLICENSED"`. This is not the public-domain Unlicense. | Research-only. Do not copy or translate the Swift/Rust implementations or fixtures without an appropriate grant. |
| whoop4-ble | [`LICENSE`](https://github.com/andyguzmaneth/whoop4-ble/blob/a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88/LICENSE): MIT License, **Copyright (c) 2026 Andy Guzman**. Package metadata points to this license. No conflicting license was found in the inspected source. Referenced antecedents still require component-level provenance review. | Standard-HR parser now adapted under MIT, with full notice packaged and exact mapping recorded. Custom-protocol code remains research-only; the inherited chain is not represented as cleared. |

Forking permission and permission to incorporate/distribute source are separate
questions. Missing-license findings do not block independently written,
appropriately sourced standard Bluetooth functionality. No legal owner, license,
or historical permission is invented to fill an unresolved field.

## Components studied and technical influence

### NOOP

Pinned source paths:

- [`android/app/src/main/java/com/noop/ble/WhoopBleClient.kt`](https://github.com/muftiarfan/noop/blob/7be90e0af86ba2c6545dbf7d051bacd370350c67/android/app/src/main/java/com/noop/ble/WhoopBleClient.kt): scanning, Android GATT operations, CCCD subscription queues, connection cleanup, reconnection and collection.
- `android/app/src/main/java/com/noop/ble/Backfiller.kt`: history collection/cursor policy.
- `android/app/src/main/java/com/noop/protocol/{DeviceFamily,Framing,Crc,Streams,HistoricalStreams}.kt`: generation models, framing and partial decoding.
- `Packages/WhoopProtocol/`, `Strand/BLE/`, `docs/BLE_REVERSE_ENGINEERING.md`, `docs/ANDROID.md` and Android protocol tests: reference behavior, evidence limits and parity fixtures.

Research contribution: demonstrated why Android GATT operations need careful
sequencing and why discovery of a 5.0 service does not establish a working 5.0
measurement pipeline. These findings inform the plan's bounded transport and
generation-specific verification gates, not a code port.

Existing [`ATTRIBUTION.md`](https://github.com/muftiarfan/noop/blob/7be90e0af86ba2c6545dbf7d051bacd370350c67/ATTRIBUTION.md)
credits `johnmiddleton12/my-whoop` for Swift packages/4.0 work, `b-nnett/goose`
for the 5.0 path, and `groue/GRDB.swift` for storage. Preserve those credits.
The named `my-whoop` origin is not assumed to be identical to the Wearable
snapshot without evidence.

**Actually reused code:** none. **WHOOP Lens source-to-destination mapping:**
none. **WHOOP Lens modifications to upstream/fork:** none.

### Wearable

Pinned source paths:

- [`ios/OpenWhoop/BLE/BLEManager.swift`](https://github.com/johnmiddleton12/wearable/blob/890e0c96beb817ab0cec3aaf7d9a06c530025355/ios/OpenWhoop/BLE/BLEManager.swift): 4.0 scan/connect, confirmed-write behavior, notifications, restoration and reconnection.
- `ios/OpenWhoop/BLE/StandardHeartRate.swift`, `ios/OpenWhoop/Collect/`, `Packages/WhoopProtocol/` and `protocol/whoop_protocol.json`: standard HR/R-R, collection, framing, schema and decoding.
- `ios/OpenWhoopTests/{BLEHandshakeTests,StandardHeartRateTests,BackfillerTests,CollectorTests,ClockCorrelationTests}.swift`, `FINDINGS.md`, `re/README.md`: tests and upstream device/protocol observations.

Research contribution: distinguished standard HR from proprietary custom-channel
setup, identified fragmented-notification handling, and illustrated why history
acknowledgments and clock commands must not be treated as passive reads. Its
CoreBluetooth lifecycle is not evidence of Samsung background behavior.

The upstream README credits `bWanShiTong/openwhoop`, `jogolden/whoomp`,
`bWanShiTong/reverse-engineering-whoop` and
`christianmeurer/whoop-reader`; it explicitly describes HRV/strain ports from
OpenWhoop. Preserve these acknowledgments and clarify permissions before any
future port. GRDB is an independently licensed dependency, not a grant for the
application code that uses it.

**Actually reused code:** none. **WHOOP Lens source-to-destination mapping:**
none. **WHOOP Lens modifications to upstream/fork:** none.

### Goose

Pinned source paths:

- [`GooseSwift/GooseBLEClient.swift`](https://github.com/b-nnett/goose/blob/ba9ae0280c9b5b9a1545baab8e944cb3b7563c62/GooseSwift/GooseBLEClient.swift) and its `+CentralDelegate`, `+PeripheralDelegate`, `+UserActions`, `+Commands`, `+HistoricalCommands`, `+HistoricalHandlers`, `+Parsing` and `+VitalsAndLogging` extensions: discovery, identity checks, hello/setup, streams, reconnect and history.
- `Rust/core/src/{protocol,commands,historical_sync,openwhoop_reference}.rs`: extended framing, CRC checks, packet summaries and provenance caveats.
- `Rust/core/fixtures/README.md`, fixture sidecars and `Rust/core/tests/{protocol_tests,fake_ble_peripheral_tests,history_sync_tests}.rs`: separation of synthetic/fake-peripheral evidence from real hardware.

Research contribution: showed that the 5.0 extended framing differs from 4.0,
that partially decoded packet summaries are not calibrated measurements, and
that synthetic fixtures cannot establish model/firmware compatibility.

`openwhoop_reference.rs` explicitly cites `bWanShiTong/openwhoop` revision
`55c5c1e2e02d3822c33e258838a57bb7d9e2ca53` and notes missing licensing at that
snapshot. The README's Bevel design credit does not authorize reuse of Bevel
assets or designs. Preserve both the provenance caveat and existing credits.

**Actually reused code:** none. **WHOOP Lens source-to-destination mapping:**
none. **WHOOP Lens modifications to upstream/fork:** none.

### whoop4-ble

Pinned source paths:

- [`src/whoop4/reader.py`](https://github.com/andyguzmaneth/whoop4-ble/blob/a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88/src/whoop4/reader.py), specifically `parse_hr_measurement`: flag-dependent standard HR/R-R parsing; also streaming and retry lifecycle.
- `src/whoop4/{scan,packet,drain,set_clock}.py`: service discovery, frame structure, partial history/event decoding, clock and history-result commands.
- `docs/{PROTOCOL,SAMPLE_SESSION,STATUS}.md`, `LICENSE` and `pyproject.toml`: author-reported real 4.0 captures, explicit unknowns, license and dependency provenance.

Research contribution: supplies concrete author-described HR/R-R captures and
documents limitations of custom packets. The inbound frame parser's incomplete
validation and plausible-range sensor guesses are reasons not to import it
unchanged. The plan uses standard HR first and excludes proprietary history,
clock and sensor-control commands.

The source/docs acknowledge `bWanShiTong`, `jogolden/whoomp`,
`cs-balazs/gowhoop`, and `project-whoopsie/whoopsie-protocol`. Exact inherited
source revisions and permissions are not supplied for every reference. Preserve
the original acknowledgments; obtain additional provenance if the relevant
custom-protocol component is selected. Dependencies include Bleak and
websockets; they are not needed for an independently written Android parser.

**Actually reused code:** `reader.py::parse_hr_measurement`, adapted under MIT
into `ble/BleModels.kt::HeartRateMeasurement.decode`. Kotlin validation/typed-field
changes are recorded in `upstream-provenance.md`; the complete original notice
is packaged in the APK. **WHOOP Lens modifications to upstream/fork:** none.

## Native fork integrity at creation

The forks were created through GitHub's native fork API, with all branches
requested. No new-root import, mirror replacement, history rewrite, reauthoring,
license edit, source change or upstream write was performed.

| Fork | Expected GitHub parent | Default branch | Preserved default-branch history at creation |
|---|---|---|---|
| `AStrasler/noop` | `muftiarfan/noop` | `main` | 3 original commits; pinned SHA above |
| `AStrasler/wearable` | `johnmiddleton12/wearable` | `main` | 1 original commit; pinned SHA above |
| `AStrasler/goose` | `b-nnett/goose` | `main` | 10 original commits; pinned SHA above |
| `AStrasler/whoop4-ble` | `andyguzmaneth/whoop4-ble` | `main` | 2 original commits; pinned SHA above |

Verification compares native parent repository IDs, default branches, all
published branch/tag refs, default-branch commit sequences and original
author/committer metadata, plus identical commit/tree SHAs. Equal Git object
IDs preserve the original history and files, including existing licenses,
copyright notices and acknowledgments. Initial fork/upstream comparisons must
show zero commits ahead and behind. These are point-in-time checks, not a
promise that future upstream changes automatically synchronize the forks.

## Requirements before future code reuse

For each selected component, record:

| Field | Required content |
|---|---|
| Origin | Original repository URL, verified author/copyright notice, exact revision and source file/function |
| Permission | Applicable license/version and file-specific notices; unresolved inherited rights are explicitly flagged |
| Usage | Copied, adapted, dependency or research-only; independently implemented work is identified separately |
| Destination | Exact WHOOP Lens paths; use **none** for research-only work |
| Changes | Material modifications and their WHOOP Lens authorship; preserve upstream contributor credit |
| Redistribution | Required license texts, copyright notices, dependency/bundled-library notices and any source-disclosure conditions |
| Verification | Review status, tests, and evidence for the selected hardware/firmware; no invented device claims |

Maintain root `THIRD_PARTY_NOTICES.md` for **actually incorporated** components
and their required notices. Preserve any existing unrelated notices. No new
incorporated-component entry or license bundle is added merely for creating
these forks. If an MIT adaptation is selected later, retain the original full
MIT license/copyright in the repository and appropriate distributed APK assets;
identify the adapted files and modifications. A permission grant must cover
the actual component, including relevant inherited code.

Before distributing an implementation, provide an accessible Android
**Open Source Licenses & Credits** section and appropriate repository credits.
Keep **Research References** separate from incorporated components, with links
to the original projects. Do not claim "incorporates" or "adapts" until it is
true. Review exact resolved dependency and transitive notices for any new
library actually shipped. Missing rights for one component need not block an
independent standard-HR implementation.

## Recommended next implementation boundary

An independently written, user-started standard Bluetooth Heart Rate Service
(`0x180D` / `0x2A37`) reader is the smallest next step: explicit strap selection,
bounded foreground session, optional R-R only when present, distinct
**WHOOP Direct BLE** source labels, truthful receipt timestamps and
account-scoped encrypted data. Require physical-device verification of the
owner's exact generation/firmware. Do not infer MG support from 5.0 UUIDs.

Keep official WHOOP API measurements authoritative and Health Connect separate.
Do not add a third source through current binary WHOOP/Health Connect routing.
Do not fabricate recovery, HRV, strain or sleep stages. Proprietary history,
clock writes, firmware operations, continuous background BLE and cloud uploads
remain outside that first prototype and require their own justified scope.
This document authorizes none of those implementation actions.
