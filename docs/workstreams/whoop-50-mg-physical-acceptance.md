# WHOOP 5.0 + WHOOP MG — independent physical acceptance

Status: **draft / both generations unverified on actual straps**. Converted from issue #100; preserve its full description and discussion in the PR.

## Established baseline, not hardware proof

Android's foreground-only Direct BLE implementation, read-only generation recognizer, compatibility research and synthetic packet tests already exist. The owner's `0.3.0-beta.1` S26 Ultra installation check proves app/account/Health Connect continuity **only**, not real WHOOP 5.0 or MG BLE compatibility.

Source-of-truth references:
- `docs/ble/GENERATION_MATRIX.md`
- `docs/ble/PHYSICAL_STRAP_TEST.md`
- `docs/ble/DIRECT_BLE.md`
- `android/app/src/main/java/io/github/astrasler/whooplens/ble/StrapCompatibility.kt`

## Session readiness (November 1, 2026)

- **Build to test:** published prerelease `android-v0.6.0-beta.5` (versionCode 12), already installed on the owner's Galaxy S26 Ultra. It includes the foreground Direct BLE screen; **no BLE or strap behavior was part of its acceptance.**
- **Verifiable from GitHub:** the [release](https://github.com/AStrasler/WHOOP-Lens/releases/tag/android-v0.6.0-beta.5) tag points at source commit `d5046132bf49c347eaf9d3d9f470cb6a7acfe11f` and ships the APK with its `.sha256` file (APK SHA-256 `80e736a120bc07b9c7ea5f156d3443aefddec44033d559ff47160d420db54903`). Signer `8aa3a7bd…7c80` and lineage `c3e4f56d…f578 → 8aa3a7bd…7c80` can be rechecked with `apksigner verify --print-certs` and `apksigner lineage --in`.
- **Owner-reported, not verifiable from this branch or `main`:** the Nov 1 device acceptance (in-place update, sign-in, data, permissions, main screens) is the owner's report, recorded in [`docs/releases/0.6.0-beta.5.md` on PR #112's branch](https://github.com/AStrasler/WHOOP-Lens/blob/design/liquid-glass-owner-refinements-20261028/docs/releases/0.6.0-beta.5.md). It reaches `main` only when #112 merges. Until then, treat it as the owner's statement, not repository evidence.
- **Install rule (new):** releases are now signed by the release key with key rotation from the original debug key, and the lineage has rollback off. **A locally built debug APK can no longer install over the app** without uninstalling, which would wipe local data. Run both sheets on the published release build, not a debug build.
- **Before each session:** record the S26 Ultra Android and One UI build, the app version from Settings → About & help, and the strap's model and firmware from the official WHOOP app (do not unpair it). Note the WHOOP subscription state.
- **Order:** Sheet A (WHOOP 5.0) and Sheet B (WHOOP MG) are independent; either can go first. Do not reuse a result across sheets.
- **Hardware availability:** the owner uses an MG. A WHOOP 5.0 session needs access to a 5.0 strap (per #84, likely the owner's sister's). Sheet A stays untested until that is arranged.
- **Engineering status:** no code change is pending for these sessions. Parsers and recognizers stay unwired from proprietary reads by design, and nothing here authorizes new GATT commands.

## Separate test sessions (equal priority)

| Evidence | WHOOP 5.0 | WHOOP MG |
| --- | --- | --- |
| Actual model and firmware | Untested | Untested |
| Galaxy S26 Ultra / One UI version | Untested | Untested |
| Bluetooth permissions and advertising | Untested | Untested |
| Observed GATT service UUIDs | Untested | Untested |
| Standard 0x180D / 0x2A37 HR notifications | Untested | Untested |
| R-R intervals if offered | Untested | Untested |
| Reconnect and foreground session stop | Untested | Untested |
| Permission revocation / stale-state behavior | Untested | Untested |
| Lock, background, account change, no upload | Untested | Untested |
| Actual subscription state and independent access | Untested | Untested |

- [ ] Run physical test sheet A using an actual **WHOOP 5.0** strap; record observed evidence, not inferred capabilities.
- [ ] Independently run sheet B using an actual **WHOOP MG** strap.
- [ ] Record firmware and generation separately; a shared UUID does not identify the model.
- [ ] Keep Android, direct BLE, official WHOOP and Health Connect measurement sources distinct.
- [ ] Update the generation matrix only from observed results; distinguish hardware-tested, upstream-claimed, experimental and unsupported.
- [ ] Never claim subscription-independent operation based on a subscribed device or synthetic test.
- [ ] Run applicable regressions and privacy/account-lifecycle checks.

## Boundaries

No new firmware modifications, proprietary GATT writes, hidden-history drain, unapproved background transfers, cross-member data access, new phone install or production rollout. The existing standard HR notification subscription remains in its already-reviewed scope. Do not expose personal measurements, raw packets or device addresses in PR evidence.

No hardware support claims before both generation-specific sessions. **Independent review, green CI and owner approval** remain required.
