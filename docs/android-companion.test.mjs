import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test('Normal Android screens allow capture independently of private recents previews', () => {
  const activity = read('../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  const rationale = read('../android/app/src/main/java/io/github/astrasler/whooplens/PermissionsRationaleActivity.kt');
  const policy = read('../android/app/src/main/java/io/github/astrasler/whooplens/ScreenCapturePrivacy.kt');
  for (const method of ['onCreate', 'onResume', 'render']) {
    assert.match(activity, new RegExp('(?:override|private) fun ' + method + '\\([^]*?applyScreenCapturePrivacy\\(this\\)'));
  }
  assert.doesNotMatch(activity + rationale, /addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  assert.match(rationale, /applyScreenCapturePrivacy\(this\)/);
  assert.match(policy, /setSecure\(exposesCredentials\)/);
  assert.match(policy, /clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  assert.match(policy, /setRecentsCapture\(false\)/);
  assert.match(policy, /activity::setRecentsScreenshotEnabled/);
});

test("Android dashboard requires private login, read permission and independently gated background reads", () => {
  const manifest=read("../android/app/src/main/AndroidManifest.xml");
  const build=read("../android/app/build.gradle.kts");
  const source=read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  const auth=read("../android/app/src/main/java/io/github/astrasler/whooplens/PrivateSession.kt");
  const health=read("../android/app/src/main/java/io/github/astrasler/whooplens/HealthDashboard.kt");
  const worker=read("../android/app/src/main/java/io/github/astrasler/whooplens/DashboardRefresh.kt");
  const network=read("../android/app/src/main/java/io/github/astrasler/whooplens/DashboardStorage.kt");
  assert.match(build,/minSdk = 34/);
  assert.match(build,/compileSdk = 36/);
  assert.match(build,/connect-client:1\.1\.0/);
  assert.match(manifest,/allowBackup="false"/);
  assert.match(manifest,/usesCleartextTraffic="false"/);
  assert.doesNotMatch(manifest+source+auth,/SERVICE_ROLE_KEY|sb_secret_|supabase_service_role/);
  assert.match(source,/permissionsLauncher\.launch\(permissions\)/);
  assert.match(source,/auth\.beginSignIn\(\)/);
  assert.match(source,/auth\.authorizationUrl\(authAttempt\)/);
  assert.match(auth,/fun beginSignIn\(\): Long/);
  assert.match(auth,/attempt != revision/);
  assert.match(source,/attempt\s*!=\s*uiGeneration/);
  assert.match(source,/\+\+uiGeneration/);
  assert.match(auth,/code_challenge_method/);
  assert.match(auth,/fun signOut/);
  assert.match(health,/hc\.aggregateGroupByPeriod\(\s*AggregateGroupByPeriodRequest/);
  assert.match(source,/getGrantedPermissions\(/);
  assert.match(health,/hc\.readRecords\(\s*ReadRecordsRequest/);
  assert.doesNotMatch(source+health+worker,/insertRecords\(|deleteRecords\(|uploadApprovedSteps\(|deleteAccountData\(/);
  assert.doesNotMatch(manifest,/android\.permission\.health\.WRITE_/);
  assert.match(source,/Nothing has been sent/i);
  assert.match(source,/AlertDialog\.Builder\(this\)/);
  assert.match(source,/Review upload \(off\)/);
  assert.match(source,/deletion is OFF/);
  assert.match(worker,/PeriodicWorkRequestBuilder<DashboardRefreshWorker>/);
  assert.match(worker,/FEATURE_READ_HEALTH_DATA_IN_BACKGROUND/);
  assert.match(worker,/PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND/);
  assert.match(worker,/current\s*!=\s*expected/);
  assert.match(network,/require\(tool in WhoopDashboard\.tools\)/);
  assert.match(network,/instanceFollowRedirects\s*=\s*false/);
  assert.doesNotMatch(network,/getString\("user_id"\)|put\("user_id"/);
});

test("Private upload export remains disabled pending approved migrations", () => {
  const source=read("../android/app/src/main/java/io/github/astrasler/whooplens/ManualSync.kt");
  assert.match(source,/const val ENABLE_UPLOADS = false/);
  assert.match(source,/check\(ENABLE_UPLOADS && draft\.valid\(\)\)/);
  assert.match(source,/if \(!ENABLE_UPLOADS\) return DeletionResult\.Disabled/);
  assert.match(source,/schema_version", 2/);
  assert.match(source,/source", "health_connect"/);
  assert.match(source,/metric", "steps_daily"/);
  assert.match(source,/record_key", "daily:/);
  assert.doesNotMatch(source,/supabase\.co|functions\/v1\/samsung-health|sb_publishable_/);
  assert.match(source,/preparedAtMs/);
  assert.match(source,/fun deleteAccountData\(/);
  assert.match(source,/fun uploadApprovedSteps\(/);
  assert.doesNotMatch(source,/SERVICE_ROLE_KEY|sb_secret_|supabase_service_role/);
});

test('Android production wiring persists sessions and excludes backup and transfer', () => {
  const activity = read('../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  const storage = read('../android/app/src/main/java/io/github/astrasler/whooplens/AndroidSessionStorage.kt');
  assert.match(activity, /AndroidSessions\.get\(applicationContext\)/);
  assert.doesNotMatch(activity.match(/override fun onDestroy\([\s\S]*?super\.onDestroy\(\)/)[0], /auth\.(signOut|clearForSignOut)/);
  assert.match(storage, /noBackupFilesDir/);
  assert.match(storage, /AtomicFile/);
  assert.match(storage, /AndroidKeyStore/);
  for (const file of ['backup_rules.xml', 'data_extraction_rules.xml']) {
    const rules = read('../android/app/src/main/res/xml/' + file);
    assert.match(rules, /<exclude domain="root" path="\."\s*\/>/);
    assert.match(rules, /<exclude domain="sharedpref" path="\."\s*\/>/);
  }
});


test('All six home widgets declare compact picker previews and bounded two-axis resizing', () => {
  for (const name of ['daily', 'recovery', 'steps', 'sleep', 'vitals', 'expanded']) {
    const xml = read('../android/app/src/main/res/xml/widget_' + name + '.xml');
    for (const attr of ['targetCellWidth', 'targetCellHeight']) assert.match(xml, new RegExp('android:' + attr + '="1"'));
    for (const attr of ['minWidth', 'minHeight', 'minResizeWidth', 'minResizeHeight']) assert.match(xml, new RegExp('android:' + attr + '="40dp"'));
    assert.match(xml, /maxResizeWidth="320dp"/);
    assert.match(xml, /maxResizeHeight="160dp"/);
    assert.match(xml, /resizeMode="horizontal\|vertical"/);
    assert.match(xml, /previewLayout="@layout\/lens_widget_responsive"/);
    assert.match(xml, /initialLayout="@layout\/lens_widget_responsive"/);
  }
});

test('Widgets remain cache-only consumers and resize/background callbacks update current account views', () => {
  const widget=read('../android/app/src/main/java/io/github/astrasler/whooplens/LensWidgets.kt');
  const worker=read('../android/app/src/main/java/io/github/astrasler/whooplens/DashboardRefresh.kt');
  const main=read('../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  assert.match(widget,/OPTION_APPWIDGET_SIZES/);
  assert.match(widget,/RemoteViews\(\s*supported\.associateWith/);
  assert.match(widget,/configuration\.fontScale/);
  assert.match(widget,/override fun onAppWidgetOptionsChanged/);
  assert.match(widget,/DashboardRepository\.read\(context, auth\)/);
  assert.match(widget,/if \(!lock && account != null\)/);
  assert.doesNotMatch(widget,/refreshToken|readRecords|insertRecords|deleteRecords|HttpURLConnection/);
  assert.match(worker,/LensWidgets\.updateAll/);
  assert.match(main,/LensWidgets\.updateAll/);
  assert.match(widget,/FLAG_IMMUTABLE/);
});
