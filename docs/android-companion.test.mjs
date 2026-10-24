import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("Android requires private login, consent and manual local-only steps aggregation", () => {
  const manifest=read("../android/app/src/main/AndroidManifest.xml");
  const build=read("../android/app/build.gradle.kts");
  const source=read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  const auth=read("../android/app/src/main/java/io/github/astrasler/whooplens/PrivateSession.kt");
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
  assert.match(source,/attempt != uiGeneration/);
  assert.match(source,/\+\+uiGeneration/);
  assert.match(auth,/code_challenge_method/);
  assert.match(auth,/fun signOut/);
  assert.match(source,/hc\.aggregate\(AggregateRequest/);
  assert.match(source,/getGrantedPermissions\(/);
  assert.match(source,/hc\.readRecords\(ReadRecordsRequest/);
  assert.doesNotMatch(source,/insertRecords\(/);
  assert.match(source,/Nothing has been sent/i);
  assert.match(source,/reviewButton\.setOnClickListener/);
  assert.match(source,/AlertDialog\.Builder\(this\)/);
  assert.match(source,/snapshot === preparedSteps/);
  assert.match(source,/ManualSync\.uploadApprovedSteps/);
  assert.match(source,/Preview yesterday's steps locally/);
  assert.match(source,/ManualSync\.deleteAccountData/);
  assert.match(source,/Confirm Server Data Deletion/);
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
  assert.doesNotMatch(activity.slice(activity.indexOf('override fun onDestroy')), /auth\.(signOut|clearForSignOut)/);
  assert.match(storage, /noBackupFilesDir/);
  assert.match(storage, /AtomicFile/);
  assert.match(storage, /AndroidKeyStore/);
  for (const file of ['backup_rules.xml', 'data_extraction_rules.xml']) {
    const rules = read('../android/app/src/main/res/xml/' + file);
    assert.match(rules, /<exclude domain="root" path="\."\s*\/>/);
    assert.match(rules, /<exclude domain="sharedpref" path="\."\s*\/>/);
  }
});
