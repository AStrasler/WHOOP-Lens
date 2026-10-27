import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parseJsonc, stripComments} from './jsonc.mjs';

const RETENTION_CRON = '17 9 * * *';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[/\\]$/, '');
const read = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function crons(config) {
  const found = [];
  if (config.triggers !== undefined) found.push({where: 'top', value: config.triggers});
  if (config.env && typeof config.env === 'object') {
    for (const [name, env] of Object.entries(config.env)) {
      if (env && env.triggers !== undefined) found.push({where: `env.${name}`, value: env.triggers});
    }
  }
  return found;
}

function assertScheduleSafeCommands(text, label) {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '');
    if (!/wrangler/.test(line)) continue;
    assert.doesNotMatch(line, /triggers\s+deploy/, `${label} must not run wrangler triggers deploy: ${raw.trim()}`);
    assert.doesNotMatch(line, /--triggers\b|--schedules?\b/, `${label} must not pass a cron override: ${raw.trim()}`);
    if (/\bdeploy\b/.test(line)) {
      assert.match(line, /--dry-run/, `${label} wrangler deploy must stay a dry run: ${raw.trim()}`);
    }
  }
}

test('commented cron text is not an effective schedule', () => {
  const commented = parseJsonc(`{
    "name": "whoop-lens",
    // "triggers": { "crons": ["17 9 * * *"] },
    "observability": { "enabled": true }
  }`);
  assert.equal(commented.triggers, undefined);
  assert.equal(commented.observability.enabled, true);
  const effective = parseJsonc(`{
    "name": "whoop-lens",
    "note": "https://example.com // not a comment",
    // "triggers": { "crons": ["17 9 * * *"] },
    "triggers": { "crons": ["1 2 * * *"] }
  }`);
  assert.equal(effective.note, 'https://example.com // not a comment');
  assert.deepEqual(effective.triggers, {crons: ['1 2 * * *']});
});

test('only the production resource Worker declares the daily retention cron', () => {
  const configs = walk(ROOT).filter(path => /[/\\]wrangler\.(jsonc|json|toml)$/.test(path));
  const relative = configs.map(path => path.slice(ROOT.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(relative, [
    'cloudflare/oauth/auth-server/wrangler.jsonc',
    'cloudflare/oauth/resource/wrangler.jsonc',
    'cloudflare/wrangler.jsonc',
    'site/wrangler.jsonc'
  ]);
  const parsed = configs.map(path => {
    const rel = path.slice(ROOT.length + 1).replaceAll('\\', '/');
    assert.equal(path.endsWith('.toml'), false, `${rel} must stay JSONC so the schedule parser applies`);
    const config = parseJsonc(readFileSync(path, 'utf8'));
    return {rel, name: config.name, schedules: crons(config)};
  });
  const resource = parsed.find(item => item.rel === 'cloudflare/oauth/resource/wrangler.jsonc');
  const legacy = parsed.find(item => item.rel === 'cloudflare/wrangler.jsonc');
  const auth = parsed.find(item => item.rel === 'cloudflare/oauth/auth-server/wrangler.jsonc');
  const site = parsed.find(item => item.rel === 'site/wrangler.jsonc');
  assert.equal(resource.name, 'whoop-lens');
  assert.deepEqual(resource.schedules, [{where: 'top', value: {crons: [RETENTION_CRON]}}]);
  // The legacy file targets the same Worker name and must not declare a schedule.
  // An empty crons array would delete the live cron on deploy; omission leaves it.
  assert.equal(legacy.name, 'whoop-lens');
  assert.deepEqual(legacy.schedules, []);
  assert.match(read('../wrangler.jsonc'), /Staged migration only/);
  assert.equal(auth.name, 'whoop-lens-auth');
  assert.deepEqual(auth.schedules, []);
  assert.equal(site.name, 'whoop-lens-site');
  assert.deepEqual(site.schedules, []);
  assert.deepEqual(parsed.filter(item => item.schedules.length).map(item => item.rel), [
    'cloudflare/oauth/resource/wrangler.jsonc'
  ]);
});

test('the resource Worker scheduled handler calls runRetention', () => {
  const worker = stripComments(read('../oauth/resource/src/index.mjs'));
  assert.match(worker, /scheduled\s*\(\s*controller\s*,\s*env\s*,\s*ctx\s*\)/);
  assert.match(worker, /runRetention\s*\(\s*env\.DB/);
  assert.doesNotMatch(worker, /\/schedules|triggers\s+deploy|--triggers\b|--schedules?\b/);
});

test('code-only release and repo commands cannot replace the live schedule', () => {
  const release = read('../scripts/release-worker-content.mjs');
  assert.match(release, /\/content/);
  assert.match(release, /method:\s*'PUT'/);
  assert.doesNotMatch(release, /\/schedules|\btriggers\b|wrangler|--triggers\b|--schedules?\b/);
  const commands = walk(ROOT).filter(path => {
    const rel = path.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (rel.startsWith('cloudflare/test/') || rel.endsWith('.md')) return false;
    if (rel.endsWith('package.json')) return true;
    if (rel.startsWith('.github/workflows/')) return true;
    if (rel.startsWith('cloudflare/scripts/')) return true;
    return false;
  });
  assert.ok(commands.some(path => path.endsWith('release-worker-content.mjs')));
  for (const path of commands) {
    assertScheduleSafeCommands(readFileSync(path, 'utf8'), path.slice(ROOT.length + 1));
  }
});

test('deploy docs forbid replacing the retention schedule from another config or flag', () => {
  const queue = readFileSync(join(ROOT, 'docs/release-queue.md'), 'utf8');
  const checklist = readFileSync(join(ROOT, 'docs/release-checklist-20261024.md'), 'utf8');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const [label, text] of [['release-queue', queue], ['release-checklist', checklist], ['README', readme]]) {
    assert.match(text, /17 9 \* \* \*/, label);
    assert.match(text, /--triggers/, label);
    assert.match(text, /wrangler triggers deploy/, label);
    assert.match(text, /--schedule/, label);
    assert.match(text, /\/content/, label);
  }
  assert.match(queue, /Only `cloudflare\/oauth\/resource\/wrangler\.jsonc` declares it/);
  assert.match(queue, /leaves them when `triggers` is omitted/);
  assert.match(queue, /`crons` is `\[\]`/);
  assert.match(checklist, /legacy `cloudflare\/wrangler\.jsonc` omits `triggers`/);
  assert.match(readme, /release-worker-content\.mjs/);
});
