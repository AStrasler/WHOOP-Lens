import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const base='android/app/src/main/java/io/github/astrasler/whooplens/ble/';

test('BLE only writes the standard CCCD and has no outbound data transport',()=>{
  const transport=read(base+'AndroidBleTransport.kt');
  assert.match(transport,/writeDescriptor\(\s*descriptor,\s*BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE\s*,?\s*\)/);
  assert.ok(!transport.includes('writeCharacteristic('));
  for(const file of readdirSync(new URL('../'+base,import.meta.url)).filter(f=>f.endsWith('.kt'))){
    const source=read(base+file);
    assert.doesNotMatch(source,/HttpURLConnection|openConnection\(|OkHttp|Log\.(?:d|i|v|w|e)\(|println\(/,file);
  }
  assert.doesNotMatch(read('android/app/src/main/java/io/github/astrasler/whooplens/ManualSync.kt'),/rrTicks|BleSession|DirectBle/);
});
test('BLE has separate encrypted no-backup storage and does not add a dashboard source',()=>{
  const storage=read(base+'AndroidBleStorage.kt');
  assert.match(storage,/noBackupFilesDir/);assert.match(storage,/whooplens\.direct-ble\.v1/);
  assert.match(storage,/EncryptedSessionStorage/);
  assert.doesNotMatch(read('android/app/src/main/java/io/github/astrasler/whooplens/DashboardData.kt'),/DIRECT_BLE/);
  const manifest=read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest,/BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation"/);
  assert.match(manifest,/BLUETOOTH_CONNECT/);assert.doesNotMatch(manifest,/BLUETOOTH_ADVERTISE|ACCESS_FINE_LOCATION|FOREGROUND_SERVICE_CONNECTED_DEVICE/);
});
test('BLE lifecycle and copied parser notices are present in repository and APK inputs',()=>{
  const activity=read('android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  assert.match(activity,/override fun onPause\(\)[\s\S]*?ble\.stop\(\)/);
  assert.match(activity,/ble\.forget\(\)/);
  const mit=read('android/app/src/main/assets/licenses/whoop4-ble-MIT.txt');
  assert.match(mit,/Copyright \(c\) 2026 Andy Guzman/);assert.match(mit,/Permission is hereby granted/);
  assert.match(read('docs/ble/upstream-provenance.md'),/parse_hr_measurement/);
  assert.match(read('THIRD_PARTY_NOTICES.md'),/BleModels.kt/);
});
test('BLE packet and freshness updates retain their view binding instead of rebuilding navigation',()=>{
  const activity=read('android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  assert.match(activity,/bleScreen\?\.update\(it, SystemClock.elapsedRealtime\(\)\)/);
  assert.match(activity,/bleScreen\?\.update\(ble.state, SystemClock.elapsedRealtime\(\)\)/);
  assert.match(read(base+'BleScreen.kt'),/internal class BleScreenBinding/);
});
test('release workflow is manual, separates signing from source builds and defaults to no publication',()=>{
  const workflow=read('.github/workflows/android-release.yml');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/^  (?:push|pull_request):/m);
  assert.match(workflow,/publish:[\s\S]*?default: false/);
  assert.match(workflow,/environment: android-release/);
  assert.match(workflow,/github\.workflow_sha/);
  assert.match(workflow,/--prerelease --latest=false/);
  assert.match(read('scripts/android_release.py'),/c3e4f56d7ebc66329585197c492635ffb457e7c0d0d273e16f16a43e72ccf578/);
});
