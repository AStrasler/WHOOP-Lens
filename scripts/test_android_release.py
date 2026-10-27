import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("android_release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


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
        with patch.object(release.subprocess, "check_output", return_value="certificate SHA-256 digest: " + "0" * 64):
            with self.assertRaisesRegex(ValueError, "certificate"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)

    def test_wrong_package_is_rejected(self):
        outputs = ["certificate SHA-256 digest: " + release.CERT,
                   "package: name='other.app' versionCode='5' versionName='0.3.0-beta.1'"]
        with patch.object(release.subprocess, "check_output", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "package/version"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)

    def test_debug_apk_is_not_a_release_asset(self):
        outputs = ["certificate SHA-256 digest: " + release.CERT,
                   "package: name='io.github.astrasler.whooplens' versionCode='5' versionName='0.3.0-beta.1'\napplication-debuggable"]
        with patch.object(release.subprocess, "check_output", side_effect=outputs):
            with self.assertRaisesRegex(ValueError, "debuggable"):
                release.verify_apk(Path("unused.apk"), Path("tools"), "0.3.0-beta.1", 5)


if __name__ == "__main__":
    unittest.main()
