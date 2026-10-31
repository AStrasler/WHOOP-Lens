import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("Vitals baseline uses history while its chart stays limited to today", () => {
  const activity = read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  const vitals = activity.split("private fun vitals(root: LinearLayout)")[1].split('for (k in listOf')[0];
  assert.match(vitals, /val history = snapshot\?\.health\?\.series\?\.get\("heart"\)\.orEmpty\(\)/);
  assert.match(vitals, /history\.filter\s*\{\s*it\.time > now - 86400000/);
  assert.match(vitals, /chart\(c, p, DataSource\.HEALTH_CONNECT\)/);
  assert.match(vitals, /baselineDelta\(latest, personalBaseline\(snapshot\?\.health\?\.baselineSeries\("heart"\)\.orEmpty\(\), now\)\)/);
  assert.match(activity, /personalBaseline\(b\?\.baselineSeries\(k\)\.orEmpty\(\)/);
  assert.match(activity, /snapshot\?\.health\?\.baselineSeries\(key\)\.orEmpty\(\)/);
  const health = read("../android/app/src/main/java/io/github/astrasler/whooplens/HealthDashboard.kt");
  assert.match(health, /heartPoints\.takeLast\(2000\)/);
  assert.match(health, /series\[HEART_RATE_DAILY\] = emptyList\(\)/);
  assert.match(health, /readHeartRateDailyHistory\(now, zone, allowed\)/);
  assert.match(health, /setOf\(HeartRateRecord\.BPM_AVG\)/);
});

test("Strain track and progress use the tested upper semicircle geometry", () => {
  const ui = read("../android/app/src/main/java/io/github/astrasler/whooplens/LensUi.kt");
  const strain = ui.split("internal class StrainArc")[1].split("internal class TrendChart")[0];
  assert.match(strain, /drawArc\(oval, 180f, strainArcSweep\(21\.0\), false, paint\)/);
  assert.match(strain, /drawArc\(oval, 180f, strainArcSweep\(it\), false, paint\)/);
});

test("Liquid glass keeps the merged repair contracts", () => {
  const activity = read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  const widgets = read("../android/app/src/main/java/io/github/astrasler/whooplens/LensWidgets.kt");
  const ble = read("../android/app/src/main/java/io/github/astrasler/whooplens/ble/BleScreen.kt");
  const strap = read("../android/app/src/main/java/io/github/astrasler/whooplens/ble/StrapCompatibility.kt");
  const notices = read("../android/app/src/main/java/io/github/astrasler/whooplens/ServiceAnnouncements.kt");
  const credits = read("../android/app/src/main/java/io/github/astrasler/whooplens/ble/OpenSourceCredits.kt");
  const ui = read("../android/app/src/main/java/io/github/astrasler/whooplens/LensUi.kt");
  const glance = read("../android/app/src/main/java/io/github/astrasler/whooplens/GlassContent.kt");
  const gradle = read("../android/app/build.gradle.kts");
  const manifest = read("../android/app/src/main/AndroidManifest.xml");
  const uploads = read("../android/app/src/main/java/io/github/astrasler/whooplens/ManualSync.kt");

  for (const hook of [
    "notices",
    "dismissedNotices",
    "noticeTick",
    "scheduleNoticeExpiry",
    "visibleNotices",
    "renderNoticeBanner",
    "renderNoticeInbox",
    "loadNotices",
  ]) {
    assert.match(activity, new RegExp(hook));
  }
  assert.match(activity, /Measurements stay off the lock screen/);
  assert.doesNotMatch(activity, /Lock-screen provider/);
  assert.match(activity, /putString\("widget-privacy", "SUMMARY"\)/);
  assert.match(activity, /putString\("glance-level", "HIDDEN"\)/);
  assert.match(activity, /resetGlance\(\)/);
  assert.match(glance, /LOCK_SCREEN_PLATFORM_VERIFIED = false/);
  assert.match(widgets, /if \(!conceal && account != null\)/);
  assert.match(widgets, /Intent\.ACTION_SCREEN_OFF/);
  assert.match(ble, /dashed = true, edgeColor = LensColors\.error/);
  assert.match(strap, /SHARED_5_0_OR_MG/);
  assert.match(notices, /https:\/\/whooplens\.tech\/v1\/announcements/);
  assert.match(ui, /value\.any \{ it\.isDigit\(\) \}/);
  assert.match(ui, /size\.coerceAtLeast\(12f\)/);
  assert.match(credits, /COVERED-BY-YOUR-GRACE-OFL\.txt/);
  assert.match(gradle, /applicationId = "io\.github\.astrasler\.whooplens"/);
  // Release versions advance independently from the visual regression contract.
  const code = gradle.match(/versionCode\s*=\s*(\d+)/);
  const version = gradle.match(/versionName\s*=\s*"([^"]+)"/);
  assert.ok(code && Number(code[1]) > 7, "Android versionCode must exceed the previous published build");
  assert.ok(version, "Android versionName must exist");
  assert.match(version[1], /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/);
  assert.match(uploads, /const val ENABLE_UPLOADS = false/);
  assert.match(manifest, /android:name="android\.permission\.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation"/);
  assert.match(manifest, /android:name="android\.permission\.USE_BIOMETRIC"/);
  const permissions = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(permissions, [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.USE_BIOMETRIC",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND",
    "android.permission.health.READ_DISTANCE",
    "android.permission.health.READ_ACTIVE_CALORIES_BURNED",
    "android.permission.health.READ_FLOORS_CLIMBED",
    "android.permission.health.READ_HEART_RATE_VARIABILITY",
    "android.permission.health.READ_RESTING_HEART_RATE",
    "android.permission.health.READ_OXYGEN_SATURATION",
    "android.permission.health.READ_RESPIRATORY_RATE",
    "android.permission.health.READ_BODY_TEMPERATURE",
    "android.permission.health.READ_BLOOD_PRESSURE",
    "android.permission.health.READ_WEIGHT",
    "android.permission.health.READ_BODY_FAT",
    "android.permission.health.READ_STEPS",
    "android.permission.health.READ_SLEEP",
    "android.permission.health.READ_HEART_RATE",
    "android.permission.health.READ_EXERCISE",
  ]);
  assert.doesNotMatch(manifest, /ACCESS_FINE_LOCATION|BLUETOOTH_ADVERTISE|health\.WRITE_|CAMERA|RECORD_AUDIO|POST_NOTIFICATIONS/);
  assert.equal(existsSync(new URL("../android/app/src/main/res/font/covered_by_your_grace.ttf", import.meta.url)), true);
  assert.equal(existsSync(new URL("../android/app/src/main/assets/COVERED-BY-YOUR-GRACE-OFL.txt", import.meta.url)), true);
  const retired = read("../android/app/src/main/res/values/lens_glass_colors.xml") + read("../android/app/src/main/java/io/github/astrasler/whooplens/GlassSurface.kt");
  assert.doesNotMatch(retired, /#5C7579|5C7579/i);
});

test("Handwritten headings in the activity do not carry digits", () => {
  const activity = read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  const headings = [...activity.matchAll(/ui\.heading\([^,]+,\s*"([^"]+)"\)/g)].map(match => match[1]);
  assert.ok(headings.length > 5);
  for (const title of headings) assert.doesNotMatch(title, /\d/, title);
});
