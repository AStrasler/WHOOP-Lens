# Third-party notices

## Incorporated BLE component: whoop4-ble standard heart-rate parser

- Original repository: https://github.com/andyguzmaneth/whoop4-ble
- Maintainer / copyright: Andy Guzman; Copyright (c) 2026 Andy Guzman.
- Revision: `a76ad4576bda9ec76cc6347ff9ad18fbcad1cd88`.
- Original: `src/whoop4/reader.py::parse_hr_measurement`.
- Adapted destination: `android/app/src/main/java/io/github/astrasler/whooplens/ble/BleModels.kt`, `HeartRateMeasurement.decode`.
- License: MIT; full unmodified license is included in `android/app/src/main/assets/licenses/whoop4-ble-MIT.txt` and distributed inside the APK, accessible through Account & Settings -> Open Source Licenses & Credits.
- Changes: Kotlin typed result, strict packet/flag/bounds validation, optional contact and energy values, original R-R ticks retained alongside explicit conversion to milliseconds. Removed I/O/storage/logging concerns. Android transport, session control and encrypted BLE cache are independently implemented.

No proprietary decoder, historical-drain code, firmware/clock command, UI asset,
test fixture, Bleak or websockets dependency is copied from that project.
Existing acknowledgments to earlier protocol researchers remain in the native
fork. They are not represented as authors of this independently implemented
transport. See [detailed provenance](docs/ble/upstream-provenance.md).

## Existing Android components

AndroidX libraries (including Health Connect and WorkManager), Kotlin/coroutines
and Apache-licensed transitive components retain their applicable Apache-2.0
license. The license text is packaged at `assets/licenses/Apache-2.0.txt`.
Their upstream authors retain copyright; their licenses do not transfer ownership.
The build's exact dependency versions remain defined in the Gradle manifests and
resolved dependency report. No new third-party runtime dependency is introduced
for Direct BLE. Required upstream META-INF notices must not be stripped by a
release packaging change; final release validation should retain the dependency
inventory alongside build evidence.

The resolved Android graph also includes Checker Framework qualifiers 3.12.0
(MIT, Copyright 2004-present by the Checker Framework developers) and AndroidX
Health Connect external protobuf 1.1.0 (BSD-3-Clause). Their original packaged
license texts are preserved verbatim at `assets/licenses/checker-qual-MIT.txt`
and `assets/licenses/health-connect-protobuf-BSD.txt`. These existing transitive
dependencies are not newly introduced by BLE. The resolved-coordinate/POM license
inventory is packaged at `assets/licenses/dependencies.json` and is readable in
the in-app credits. Guava's Apache-2.0 terms are declared in its parent POMs.

Inter and JetBrains Mono retain their existing SIL Open Font License notices at
`android/app/src/main/assets/INTER-OFL.txt` and `JETBRAINS-MONO-OFL.txt`; both are
also readable in the in-app credits. Existing fonts and notices are unchanged.

## Research references, not incorporated code

NOOP, Wearable and Goose are research references only. No license grant for
incorporating their source has been established. Their native forks preserve
history and existing credits; that does not authorize relicensing their work.
See [UPSTREAM_CREDITS.md](docs/ble/UPSTREAM_CREDITS.md) for full revisions,
maintainers, sources and inherited-provenance caveats. No endorsement by these
developers or WHOOP is implied.
