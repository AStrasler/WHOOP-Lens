import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
test("Android beta scaffold is private, limited and has no embedded service credentials", () => {
  const manifest=read("../android/app/src/main/AndroidManifest.xml");
  const build=read("../android/app/build.gradle.kts");
  const source=read("../android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt");
  assert.match(build,/minSdk = 34/);
  assert.match(build,/connect-client:1\.1\.0/);
  assert.match(manifest,/allowBackup="false"/);
  assert.match(manifest,/usesCleartextTraffic="false"/);
  assert.doesNotMatch(manifest+source,/SERVICE_ROLE_KEY|sb_secret_|supabase_service_role/);
  assert.doesNotMatch(source,/readRecords\(|insertRecords\(|HttpURLConnection|OkHttpClient/);
  assert.match(source,/nothing is read or uploaded/i);
});
