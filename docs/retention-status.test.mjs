import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const diagnostics = readFileSync(new URL('../cloudflare/docs/member-diagnostics.md', import.meta.url), 'utf8');
const backlog = readFileSync(new URL('./repair-backlog.md', import.meta.url), 'utf8');

test('member diagnostics describe the daily cron and the request-time fallback', () => {
  assert.match(diagnostics, /17 9 \* \* \*/);
  assert.match(diagnostics, /`scheduled\(\)` handler calls `runRetention\(\)`/);
  assert.match(diagnostics, /even when no member is active/);
  assert.match(diagnostics, /Request-time cleanup is the fallback/);
  assert.match(diagnostics, /at most 50 expired diagnostic rows per batch/);
  assert.match(diagnostics, /when capture is turned off/);
  assert.match(diagnostics, /at most once a minute per worker instance/);
  assert.match(diagnostics, /180 days after their last update/);
  assert.match(diagnostics, /expired approvals are purged too/);
  assert.match(diagnostics, /report preview, submission, and owner review/);
  assert.match(diagnostics, /independently of member traffic/);
  assert.doesNotMatch(diagnostics, /There is no cron trigger/);
  assert.doesNotMatch(diagnostics, /not yet declared/);
});

test('repair backlog separates the live daily cron from the Oct 25 snapshot', () => {
  const current = backlog.slice(backlog.indexOf('Current RB-016 retention state'), backlog.indexOf('| ID |'));
  assert.match(current, /17 9 \* \* \*/);
  assert.match(current, /`scheduled\(\)` calls `runRetention\(\)`/);
  assert.match(current, /older than 30 days/);
  assert.match(current, /older than 180 days/);
  assert.match(current, /expired approvals/);
  assert.match(current, /when no member is active/);
  assert.match(current, /Request-time cleanup in `capture\(\)`/);
  assert.match(current, /preview, submission, and owner review remains the fallback/);
  assert.doesNotMatch(current, /neither relevant Wrangler file|Configuration drift remains open|There is no cron trigger/);
  const historical = backlog.slice(backlog.indexOf('**RB-016: retention is opportunistic.**'));
  assert.match(historical, /Oct 25 snapshot/);
  assert.match(historical, /no Worker has a cron trigger/);
  assert.match(historical, /current RB-016 status superseded/);
});
