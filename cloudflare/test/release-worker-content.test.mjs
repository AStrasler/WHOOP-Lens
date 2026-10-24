import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseContent} from '../scripts/release-worker-content.mjs';

const settings = {compatibility_date: '2026-10-11', observability: {enabled: true}, bindings: [
  {name: 'DB', type: 'd1', database_id: 'synthetic'},
  {name: 'WHOOP_CLIENT_SECRET', type: 'secret_text'},
  {name: 'BK_WHOOP_CLIENT_SECRET', type: 'secrets_store_secret', store_id: 'store', secret_name: 'secret'},
  {name: 'MCP_ENABLED', type: 'plain_text', text: 'true'}
]};
const snapshot = {workers: [{name: 'whoop-lens', settings, deployment: {versions: [{version_id: 'before', percentage: 100}]}}]};
const code = '// synthetic bundle\n'.repeat(20);
function fixture({drift = false, concurrent = false} = {}) {
  const writes = [];
  let reads = 0;
  const api = async (path, options = {}) => {
    if (options.method) { writes.push({path, ...options}); return {}; }
    if (path === '/settings') return drift ? {...settings, bindings: []} : settings;
    reads++;
    return {deployments: [{versions: [{version_id: writes.length ? 'after' : concurrent && reads > 1 ? 'changed' : 'before', percentage: 100}]}]};
  };
  return {api, writes};
}
test('release preview never writes', async () => {
  const f = fixture();
  const plan = await releaseContent({worker: 'whoop-lens', code, snapshot, api: f.api});
  assert.equal(plan.apply, false); assert.equal(f.writes.length, 0);
});
test('code-only upload excludes every production setting and preserves bindings', async () => {
  const f = fixture();
  const result = await releaseContent({worker: 'whoop-lens', code, snapshot, api: f.api, apply: true});
  assert.equal(result.deployedVersion, 'after'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, '/content'); assert.equal(f.writes[0].method, 'PUT');
  const form = f.writes[0].body;
  assert.deepEqual(JSON.parse(await form.get('metadata').text()), {main_module: 'index.js'});
  assert.equal(await form.get('index.js').text(), code);
  assert.deepEqual([...form.keys()], ['metadata', 'index.js']);
});
test('settings drift refuses to deploy', async () => {
  const f = fixture({drift: true});
  await assert.rejects(releaseContent({worker: 'whoop-lens', code, snapshot, api: f.api, apply: true}), /settings changed/);
  assert.equal(f.writes.length, 0);
});
test('concurrent deployment refuses to upload', async () => {
  const f = fixture({concurrent: true});
  await assert.rejects(releaseContent({worker: 'whoop-lens', code, snapshot, api: f.api, apply: true}), /Production changed/);
  assert.equal(f.writes.length, 0);
});
