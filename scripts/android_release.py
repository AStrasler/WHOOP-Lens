"""Local/CI release gates. No network, signing secrets, upload or publication here."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

PACKAGE = "io.github.astrasler.whooplens"
CERT = "c3e4f56d7ebc66329585197c492635ffb457e7c0d0d273e16f16a43e72ccf578"


def release_metadata(gradle, sha, tag, channel, minimum_code):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Select an immutable 40-character source commit")
    version = re.search(r'versionName\s*=\s*"([^"]+)"', gradle).group(1)
    code = int(re.search(r"versionCode\s*=\s*(\d+)", gradle).group(1))
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?", version):
        raise ValueError("Unsupported semantic version")
    if tag != "android-v" + version or code <= minimum_code:
        raise ValueError("Tag must match source version; versionCode must exceed all published codes")
    if channel not in ("stable", "experimental") or (("-" in version) != (channel == "experimental")):
        raise ValueError("Stable and experimental version/channel mismatch")
    return {"sha": sha, "version": version, "code": code, "tag": tag,
            "channel": channel, "filename": "WHOOP-Lens-" + tag + ".apk"}


def verify_apk(apk, build_tools, version, code, allow_debug=False):
    suffix = ".bat" if os.name == "nt" else ""
    certs = subprocess.check_output([str(build_tools / ("apksigner" + suffix)), "verify", "--print-certs", str(apk)], text=True)
    actual = re.findall(r"certificate SHA-256 digest: ([0-9a-f]+)", certs)
    if actual != [CERT]:
        raise ValueError("APK certificate does not match established App Links/install identity")
    badging = subprocess.check_output([str(build_tools / ("aapt" + (".exe" if os.name == "nt" else ""))), "dump", "badging", str(apk)], text=True, encoding="utf-8")
    identity = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
    if not identity or identity.groups() != (PACKAGE, str(code), version):
        raise ValueError("APK package/version does not match selected release metadata")
    if not allow_debug and "application-debuggable" in badging:
        raise ValueError("A published release APK must not be debuggable")
    permissions = re.findall(r"uses-permission(?:-sdk-\d+)?: name='([^']+)'", badging)
    bluetooth = {p for p in permissions if "BLUETOOTH" in p}
    if bluetooth != {"android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"}:
        raise ValueError("Unexpected Bluetooth permissions")
    if any(p in permissions for p in ("android.permission.ACCESS_FINE_LOCATION", "android.permission.BLUETOOTH_ADVERTISE")):
        raise ValueError("Unnecessary BLE permissions")
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        for required in ("assets/licenses/whoop4-ble-MIT.txt", "assets/licenses/Apache-2.0.txt", "assets/licenses/checker-qual-MIT.txt", "assets/licenses/health-connect-protobuf-BSD.txt", "assets/licenses/dependencies.json", "assets/INTER-OFL.txt", "assets/JETBRAINS-MONO-OFL.txt"):
            if required not in names or not z.read(required):
                raise ValueError("Missing packaged notice: " + required)
        if any(n.lower().endswith((".jks", ".keystore", "direct-ble.bin", "oauth-session.bin", "dashboard.bin")) for n in names):
            raise ValueError("Private build/runtime material must not be packaged")
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    return {"package": PACKAGE, "version": version, "code": code, "certificate_sha256": CERT,
            "apk_sha256": digest, "permissions": permissions}


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    source = sub.add_parser("source")
    source.add_argument("--sha", required=True)
    source.add_argument("--tag", required=True)
    source.add_argument("--channel", choices=["stable", "experimental"], required=True)
    source.add_argument("--minimum-code", type=int, required=True)
    apk = sub.add_parser("apk")
    apk.add_argument("--apk", type=Path, required=True)
    apk.add_argument("--build-tools", type=Path, required=True)
    apk.add_argument("--version", required=True)
    apk.add_argument("--code", type=int, required=True)
    apk.add_argument("--allow-debug", action="store_true")
    a = p.parse_args()
    if a.command == "source":
        if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != a.sha:
            raise ValueError("Checked-out commit differs from release source")
        result = release_metadata(Path("android/app/build.gradle.kts").read_text(), a.sha, a.tag, a.channel, a.minimum_code)
    else:
        result = verify_apk(a.apk, a.build_tools, a.version, a.code, a.allow_debug)
        a.apk.with_suffix(a.apk.suffix + ".sha256").write_text(result["apk_sha256"] + "  " + a.apk.name + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
