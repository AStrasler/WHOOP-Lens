import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("Android companion requires private login and explicit Health Connect consent", () => {
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
  assert.match(source,/auth\.signIn\(address, secret\)/);
  assert.match(auth,/whoop-mcp\/status/);
  assert.match(auth,/fun signOut/);
  assert.doesNotMatch(source,/readRecords\(|insertRecords\(/);
  assert.match(source,/No records are read or uploaded/i);
});
