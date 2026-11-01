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
  assert.match(read('android/app/src/main/java/io/github/astrasler/whooplens/ManualSync.kt'),/ENABLE_UPLOADS\s*=\s*false/);
});
test('BLE has separate encrypted no-backup storage and does not add a dashboard source',()=>{
  const storage=read(base+'AndroidBleStorage.kt');
  assert.match(storage,/noBackupFilesDir/);assert.match(storage,/whooplens\.direct-ble\.v1/);
  assert.match(storage,/EncryptedSessionStorage/);
  assert.doesNotMatch(read('android/app/src/main/java/io/github/astrasler/whooplens/DashboardData.kt'),/DIRECT_BLE/);
  const manifest=read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest,/BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation"/);
  assert.match(manifest,/BLUETOOTH_CONNECT/);assert.doesNotMatch(manifest,/BLUETOOTH_ADVERTISE|ACCESS_FINE_LOCATION|ACCESS_BACKGROUND_LOCATION|FOREGROUND_SERVICE_LOCATION|FOREGROUND_SERVICE_HEALTH/);
  // Background Direct BLE is a member-started connected-device session only: one non-exported service, no boot or scheduled start.
  assert.match(manifest,/FOREGROUND_SERVICE_CONNECTED_DEVICE/);
  assert.match(manifest,/<service\s+android:name="\.BleSessionService"\s+android:exported="false"\s+android:foregroundServiceType="connectedDevice"\s*\/>/);
  assert.equal([...manifest.matchAll(/<service\b/g)].length,1);
  assert.doesNotMatch(manifest,/RECEIVE_BOOT_COMPLETED|BOOT_COMPLETED/);
});
test('BLE lifecycle and copied parser notices are present in repository and APK inputs',()=>{
  const activity=read('android/app/src/main/java/io/github/astrasler/whooplens/MainActivity.kt');
  // Pausing ends scanning only; a connected session continues in the foreground service.
  const onPause=activity.match(/override fun onPause\(\)[\s\S]*?\n    }\n/)[0];
  assert.match(onPause,/ble\.stopScan\(\)/);assert.doesNotMatch(onPause,/ble\.stop\(\)/);
  const runtime=read(base+'BleRuntime.kt');
  assert.match(runtime,/FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/);
  assert.match(runtime,/START_NOT_STICKY/);assert.doesNotMatch(runtime,/START_STICKY\b|START_REDELIVER_INTENT/);
  assert.match(runtime,/override fun onTaskRemoved[\s\S]*?\.stop\(\)/);
  assert.match(runtime,/VISIBILITY_PRIVATE/);assert.match(runtime,/setPublicVersion/);
  assert.doesNotMatch(runtime,/bpm|measurement|rrTicks/,'the notification must not show readings');
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
  // Key rotation: releases are signed by the release key with the original key in their lineage.
  assert.match(read('scripts/android_release.py'),/CERT = "8aa3a7bd9acd71191de151d6c4ae4d04dd3e08ef5724e6d133a9030b367e7c80"/);
  assert.match(workflow,/--v1-signing-enabled false --v2-signing-enabled false --v3-signing-enabled true/);
  assert.match(workflow,/--ks "\$release_key"/);
  assert.doesNotMatch(workflow,/ANDROID_SIGNING_KEYSTORE_BASE64|--next-signer/,'the original debug key is not used in CI');
  assert.match(workflow,/--lineage "\$lineage" --rotation-min-sdk-version 34/);
});
