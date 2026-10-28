# Android GitHub Releases and Obtainium

Prepared only: no workflow dispatch, tag, release, APK upload or visibility change
is authorized by this work. PRs #84/#85 remain open and unmerged.

## Proposed first experimental release

- Version: `0.3.0-beta.1`, Android `versionCode=5` (previous installed/tested build: 4).
- Tag: `android-v0.3.0-beta.1`.
- Single release APK: `WHOOP-Lens-android-v0.3.0-beta.1.apk`.
- Checksum: `WHOOP-Lens-android-v0.3.0-beta.1.apk.sha256`.
- Application ID: `io.github.astrasler.whooplens` (unchanged).
- Experimental channel: GitHub prerelease, never marked latest/stable.
- Stable channel: version/tag without prerelease suffix, ordinary GitHub Release,
  only after validation and owner approval. Both use the same application ID and
  certificate. They replace one another; they are not side-by-side installations.

The published `0.3.0-beta.1` record above stays as released. The next candidate,
not published by this change, is `0.4.0-beta.1` with Android `versionCode=6`,
the same application ID `io.github.astrasler.whooplens`, and the same certificate
fingerprint. Do not dispatch the release workflow for that candidate from the
design branch.

Every published Android update must increase versionCode across **both** channels.
Semantic version sorting does not substitute for this rule. Switching back to an
older stable APK cannot bypass Android's downgrade restrictions; do not uninstall
to force it. Publish a newer-code approved stable build when needed.

## Signing compatibility

Established SHA-256 certificate fingerprint:

```text
C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78
```

This is the actual certificate of the existing
`WHOOP-Lens-0.2.2-widgets-debug.apk` and the current App Links configuration.
It is an Android Debug certificate, not a newly created production identity.
The local release-variant APK is signed using that **same existing key**;
non-debuggable release variant and certificate type are separate facts. Keep
that private key protected. Do not generate a replacement keystore merely to
make the workflow pass. A future identity change needs an explicit migration
decision and separate approval.

Local APK verification checks the real signature, exact certificate, application
ID, versionCode/versionName, release non-debuggable status, BLE permissions,
required packaged notices and absence of private runtime/keystore files.
Debug builds require explicit `--allow-debug` and are not publication assets.
No instrumentation/fixture classes belong in the companion DEX.

Matching the existing supplied APK establishes signing compatibility with that
artifact. An emulator in-place update is an additional local check. Neither
proves what certificate is installed on the Samsung or long-term OAuth/Keystore
continuity there; owner verification is required before claiming phone upgrade
success. Never uninstall or clear data for this test.

## Workflow and exact remaining setup

`.github/workflows/android-release.yml` is manual-only, with immutable
`source_sha`, matching `release_tag`, channel and `publish=false` by default.
The selected reviewed source is checked out without persisted credentials.
The validation job has no signing secrets, runs Android tests/lint and local
privacy/release gates, and builds an unsigned release APK. Validation-only
runs retain that unsigned intermediate as a short-lived Actions artifact;
they create no GitHub Release or signed public APK.

The optional signing/publication job uses the **trusted workflow revision** for
verification scripts, downloads that run's unsigned artifact, signs it, rejects
any certificate mismatch, computes SHA-256 and publishes exactly one APK plus
checksum. It never overwrites an existing release/tag or moves a tag. Release
notes record source SHA, versionCode, supported measurements and hardware limits.

Before any approved publication:

1. Review/push this separate branch only after approval. The workflow must be
   made available on the repository's default branch through a separately
   approved process before manual dispatch is generally available. Do not merge
   #84 or #85 as a side effect.
2. Create GitHub Environment **`android-release`**, configure required owner
   reviewers and appropriate branch policies. It did not exist at inspection;
   the repository only had `github-pages` with a branch policy.
3. Add these **environment secrets**, using the established keystore:
   `ANDROID_SIGNING_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. No repository signing secrets
   existed at inspection. Secret values/key bytes are never committed, printed
   or included in artifacts. Secret provisioning is a separate owner action.
4. Select the exact reviewed full source commit and matching proposed tag/channel.
   Validate first with `publish=false`. The workflow rejects a reused versionCode
   against all existing Android release notes (including prereleases), and
   stops if a previous Android release lacks versionCode evidence.
5. Approve phone installation/testing and review its results. Approve the first
   prerelease separately, then dispatch `publish=true` and approve the protected
   environment. The workflow deletes its temporary key on completion/failure.

Local source/APK gate utility: `scripts/android_release.py`. Its tests include
mutable source rejection, tag mismatch, reused code and stable/prerelease channel
mismatch. Local syntax checks do not constitute a successful GitHub Actions run.
No Actions secrets, environments or repository settings were changed here.

## Obtainium setup after approved publication

Repository visibility was checked through the authenticated GitHub metadata API:
**public**. No visibility change was made. Public release assets can be read
without authentication; before the first release is published there is no APK
for Obtainium to discover.

1. In Obtainium choose Add App, select GitHub, enter
   `https://github.com/AStrasler/WHOOP-Lens`.
2. Stable: leave Include prereleases OFF and drafts OFF. Filter release titles
   with `^WHOOP Lens Android [0-9]+\.[0-9]+\.[0-9]+$`.
3. Experimental: enable Include prereleases; leave drafts OFF. Filter release
   titles with `^WHOOP Lens Android [0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$`.
4. APK filter: `^WHOOP-Lens-android-v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?\.apk$`.
   There is one universal APK, no ambiguous debug or per-architecture variants.
   Do not enable Latest-tag selection for experimental releases; the workflow
   intentionally does not mark them latest. Version codes remain authoritative
   for installation. Retain APK version detection; no track-only workaround.
5. Allow Android's app-install permission for Obtainium when prompted and review
   the update. The release signature must match the installed app; never accept
   a request to uninstall/reset as an update path.

If the repository later becomes private, Obtainium's GitHub source supports a
GitHub PAT in source settings and authenticated API asset downloads. Use a
fine-grained token restricted to this repository with **Contents: read**, an
expiry and an account authorized for the private repository. Do not paste a
token into a repository URL, config export, issue or log, and do not use a proxy
that would receive that credential. Private access still needs an actual
post-publication download test; no private distribution is claimed tested here.
There is no reason to change repository visibility for the current public setup.

References checked: [Obtainium source/filter guidance](https://wiki.obtainium.imranr.dev/sources/),
[Obtainium GitHub download implementation](https://github.com/ImranR98/Obtainium/blob/main/lib/app_sources/github.dart),
[GitHub release asset permissions](https://docs.github.com/en/rest/releases/assets#get-a-release-asset),
[Android APK signing verification](https://developer.android.com/tools/apksigner).

## Publication notes template

```text
WHOOP Lens Android <version> — experimental Direct BLE
Source commit: <reviewed full SHA>
Android versionCode: <monotonically increasing integer>

Standard HR and optional R-R; foreground-only; account-scoped encrypted cache.
Official WHOOP API, Health Connect and widgets remain separate.
No uploads, health deletion, proprietary unlock/clock/history commands or firmware changes.
Hardware tested: <exact phone, strap generation, firmware, measurements actually verified>.
Untested hardware and limitations: <explicit list; do not infer MG support>.
Install over the existing same-certificate application; do not uninstall/reset.
```
