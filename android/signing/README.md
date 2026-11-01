# Android signing

`whooplens-lineage.bin` is the public APK Signature Scheme v3 rotation proof from
the original Android Debug key (`C3:E4:F5:…:F5:78`) to the WhoopLens release key
(`8A:A3:A7:…:7C:80`). It contains no private key material. The release workflow
uses it with both keys so existing installs update in place.

Keystores never belong in this repository. See `docs/ANDROID_RELEASES.md`.
