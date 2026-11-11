import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("android_release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def verify_output(*digests):
    """Shape of `apksigner verify --print-certs` (build-tools 36, captured Nov 1 2026)."""
    lines = []
    for i, d in enumerate(digests, 1):
        lines += ["Signer #%d certificate DN: CN=test" % i,
                  "Signer #%d certificate SHA-256 digest: %s" % (i, d),
                  "Signer #%d certificate SHA-1 digest: %s" % (i, "0" * 40)]
    return "\n".join(lines) + "\n"


def lineage_output(*digests):
    """Shape of `apksigner lineage --in <apk> --print-certs`."""
    return "".join("Signer #%d in lineage certificate SHA-256 digest: %s\n" % (i, d)
                   for i, d in enumerate(digests, 1))


BADGING = "package: name='io.github.astrasler.whooplens' versionCode='5' versionName='0.3.0-beta.1'\n"


class ReleaseGateTests(unittest.TestCase):
    gradle = 'versionCode = 5\nversionName = "0.3.0-beta.1"'
    sha = "e" * 40

    def test_experimental_metadata(self):
        result = release.release_metadata(self.gradle, self.sha, "android-v0.3.0-beta.1", "experimental", 4)
        self.assertEqual(result["filename"], "WHOOP-Lens-android-v0.3.0-beta.1.apk")

    def test_mutable_source_rejected(self):
        with self.assertRaises(ValueError):
            release.release_metadata(self.gradle, "main", "android-v0.3.0-beta.1", "experimental", 4)

    def test_mislabelled_stable_rejected(self):
        with self.assertRaises(ValueError):
            release.release_metadata(self.gradle, self.sha, "android-v0.3.0-beta.1", "stable", 4)

    def test_reused_version_code_rejected(self):
        with self.assertRaises(ValueError):
            release.release_metadata(self.gradle, self.sha, "android-v0.3.0-beta.1", "experimental", 5)

    def test_tag_must_match_apk_version(self):
        with self.assertRaises(ValueError):
            release.release_metadata(self.gradle, self.sha, "android-v0.3.0", "experimental", 4)

    def test_stable_metadata(self):
        result = release.release_metadata('versionCode = 6\nversionName = "0.3.0"', self.sha, "android-v0.3.0", "stable", 5)
        self.assertEqual(result["channel"], "stable")

    def test_different_signing_identity_is_rejected(self):
        with patch.object(release.subprocess, "check_output", return_value=verify_output("0" * 64)):
            with self.assertRaisesRegex(ValueError, "certificate"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)

    def test_wrong_package_is_rejected(self):
        outputs = [verify_output(release.CERT), lineage_output(release.OLD_CERT, release.CERT),
                   "package: name='other.app' versionCode='5' versionName='0.3.0-beta.1'"]
        with patch.object(release.subprocess, "check_output", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "package/version"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)

    def test_debug_apk_is_not_a_release_asset(self):
        outputs = [verify_output(release.CERT), lineage_output(release.OLD_CERT, release.CERT),
                   BADGING + "application-debuggable"]
        with patch.object(release.subprocess, "check_output", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "debuggable"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)

    # Key rotation (docs/ANDROID_RELEASES.md). Fingerprints are the real ones.
    def test_identity_constants(self):
        self.assertEqual(release.OLD_CERT, "c3e4f56d7ebc66329585197c492635ffb457e7c0d0d273e16f16a43e72ccf578")
        self.assertEqual(release.CERT, "8aa3a7bd9acd71191de151d6c4ae4d04dd3e08ef5724e6d133a9030b367e7c80")
        self.assertEqual(release.LINEAGE, [release.OLD_CERT, release.CERT])

    def test_rotated_release_signing_is_accepted(self):
        outputs = [verify_output(release.CERT), lineage_output(release.OLD_CERT, release.CERT)]
        with patch.object(release.subprocess, "check_output", side_effect=outputs) as run:
            result = release.verify_signing(Path("apksigner"), Path("app.apk"))
        self.assertEqual(result, {"certificate_sha256": release.CERT, "lineage": [release.OLD_CERT, release.CERT]})
        self.assertEqual(run.call_args_list[1].args[0], ["apksigner", "lineage", "--in", "app.apk", "--print-certs"])

    def test_windows_signer_passes_apk_as_one_java_argument(self):
        tools = Path("@SDK build tools")
        apk = Path("candidate.apk&echo(UNEXPECTED&rem=tail.apk")
        java_home = Path("Java installation")
        jar = tools.absolute() / "lib" / "apksigner.jar"
        outputs = [verify_output(release.CERT), lineage_output(release.OLD_CERT, release.CERT)]
        with patch.dict(release.os.environ, {"JAVA_HOME": f'"{java_home}"'}), \
             patch.object(Path, "is_file", lambda path: path == jar), \
             patch.object(release.subprocess, "check_output", side_effect=outputs) as run:
            result = release.verify_signing(tools / "apksigner.bat", apk)

        command = [str(java_home / "bin" / "java.exe"), "-Xmx1024M", "-Xss1m", "-jar", str(jar)]
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            [*command, "verify", "--print-certs", str(apk)],
            [*command, "lineage", "--in", str(apk), "--print-certs"],
        ])
        self.assertEqual([call.kwargs["shell"] for call in run.call_args_list], [False, False])
        self.assertEqual(result, {"certificate_sha256": release.CERT, "lineage": release.LINEAGE})

    def test_release_signed_only_by_the_old_key_is_rejected(self):
        with patch.object(release.subprocess, "check_output", return_value=verify_output(release.OLD_CERT)):
            with self.assertRaisesRegex(ValueError, "certificate"):
                release.verify_signing(Path("apksigner"), Path("app.apk"))

    def test_new_key_without_lineage_is_rejected(self):
        # Installs signed by the old key could not update to this APK.
        outputs = [verify_output(release.CERT), ""]
        with patch.object(release.subprocess, "check_output", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "lineage"):
                release.verify_signing(Path("apksigner"), Path("app.apk"))

    def test_wrong_or_reordered_lineage_is_rejected(self):
        for chain in [(release.CERT, release.OLD_CERT), ("0" * 64, release.CERT),
                      (release.OLD_CERT, "1" * 64, release.CERT), (release.CERT,)]:
            with patch.object(release.subprocess, "check_output", side_effect=[verify_output(release.CERT), lineage_output(*chain)]):
                with self.assertRaisesRegex(ValueError, "lineage"):
                    release.verify_signing(Path("apksigner"), Path("app.apk"))

    def test_multiple_signers_are_rejected(self):
        with patch.object(release.subprocess, "check_output", return_value=verify_output(release.CERT, release.OLD_CERT)):
            with self.assertRaisesRegex(ValueError, "certificate"):
                release.verify_signing(Path("apksigner"), Path("app.apk"))

    def test_local_debug_build_may_use_the_old_key(self):
        with patch.object(release.subprocess, "check_output", return_value=verify_output(release.OLD_CERT)):
            result = release.verify_signing(Path("apksigner"), Path("app.apk"), allow_debug=True)
        self.assertEqual(result["certificate_sha256"], release.OLD_CERT)

    def test_committed_lineage_file_holds_exactly_the_two_certificates(self):
        import hashlib
        data = (Path(__file__).parent.parent / "android" / "signing" / "whooplens-lineage.bin").read_bytes()
        found = []
        for i in range(len(data) - 4):
            if data[i] == 0x30 and data[i + 1] == 0x82:
                der = data[i:i + 4 + ((data[i + 2] << 8) | data[i + 3])]
                digest = hashlib.sha256(der).hexdigest()
                if digest in release.LINEAGE and digest not in found:
                    found.append(digest)
        self.assertEqual(found, release.LINEAGE)


if __name__ == "__main__":
    unittest.main()
