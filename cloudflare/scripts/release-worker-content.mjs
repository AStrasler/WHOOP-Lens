// Code-only release preparation. The default is read-only; --apply deploys and requires owner approval.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
export function settingsIdentity(settings) {
  const {annotations, ...rest} = settings;
  return JSON.stringify(ordered({...rest, bindings: [...(rest.bindings || [])].sort((a, b) => a.name.localeCompare(b.name))}));
}
function singleVersion(deployments) {
  const versions = deployments?.deployments?.[0]?.versions;
  if (versions?.length !== 1 || versions[0].percentage !== 100) throw Error('Expected one fully deployed version');
  return versions[0].version_id;
}
export async function releaseContent({worker, code, snapshot, api, apply = false}) {
  if (!['whoop-lens', 'whoop-lens-auth'].includes(worker)) throw Error('Unsupported release Worker');
  if (!code || code.length < 100 || /<<<<<<<|>>>>>>>/.test(code)) throw Error('Invalid Worker bundle');
  const expected = snapshot.workers.find(w => w.name === worker);
  if (!expected) throw Error('Missing Worker snapshot');
  const expectedVersion = singleVersion({deployments: [expected.deployment]});
  const before = await api('/settings');
  if (settingsIdentity(before) !== settingsIdentity(expected.settings)) throw Error('Production settings changed; recapture and review');
  const currentVersion = singleVersion(await api('/deployments'));
  if (currentVersion !== expectedVersion) throw Error('Production version changed; recapture and review');
  const plan = {worker, apply, rollbackVersion: currentVersion, bundleSha256: sha256(code), bindingCount: before.bindings.length};
  if (!apply) return plan;
  // Check again immediately before the upload. This endpoint accepts code only,
  // unlike the normal script/settings endpoints that can replace the binding list.
  if (settingsIdentity(await api('/settings')) !== settingsIdentity(before) ||
      singleVersion(await api('/deployments')) !== currentVersion) throw Error('Production changed during preparation');
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({main_module: 'index.js'})], {type: 'application/json'}));
  form.append('index.js', new Blob([code], {type: 'application/javascript+module'}), 'index.js');
  await api('/content', {method: 'PUT', body: form});
  if (settingsIdentity(await api('/settings')) !== settingsIdentity(before))
    throw Error('POST-DEPLOY SETTINGS VERIFICATION FAILED: inspect and roll back before further releases');
  return {...plan, deployedVersion: singleVersion(await api('/deployments')), smokeTestsRequired: true};
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw Error('Required ' + name); return args[i + 1]; };
  const worker = value('--worker');
  const snapshot = JSON.parse(await readFile(value('--snapshot'), 'utf8'));
  const code = await readFile(value('--bundle'), 'utf8');
  if (args.includes('--offline')) {
    if (args.includes('--apply')) throw Error('Offline mode cannot deploy');
    const entry = snapshot.workers.find(w => w.name === worker);
    if (!entry) throw Error('Missing Worker snapshot');
    console.log(JSON.stringify(await releaseContent({worker, code, snapshot, api: async path =>
      path === '/settings' ? entry.settings : {deployments: [entry.deployment]}}), null, 2));
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw Error('Cloudflare API credentials are required; never put them in source or arguments');
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${worker}${path}`,
      {...options, headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(30000)});
    const data = await response.json();
    if (!response.ok || data.success === false) throw Error('Cloudflare release request failed (HTTP ' + response.status + ')');
    return data.result;
  };
  console.log(JSON.stringify(await releaseContent({worker, code, snapshot, api, apply: args.includes('--apply')}), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('Release failed. No credential or upstream response is included. Check reviewed settings/version and local artifact paths.'); process.exitCode = 1; });
