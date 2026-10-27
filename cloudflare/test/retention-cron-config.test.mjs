import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('the live resource Worker config pins the existing daily retention cron', () => {
  const config = read('../oauth/resource/wrangler.jsonc');
  assert.match(config, /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*"17 9 \* \* \*"\s*\]\s*\}/);
  assert.match(config, /"name"\s*:\s*"whoop-lens"/);
});

test('the configured live Worker implements scheduled retention', () => {
  const worker = read('../oauth/resource/src/index.mjs');
  assert.match(worker, /scheduled\s*\(controller,\s*env,\s*ctx\)/);
  assert.match(worker, /runRetention\s*\(env\.DB/);
});

test('the legacy staged config is not the cron source of truth', () => {
  const staged = read('../wrangler.jsonc');
  assert.doesNotMatch(staged, /"triggers"\s*:/);
  assert.match(staged, /Staged migration only/);
});
