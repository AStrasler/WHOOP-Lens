// Run with a local Wrangler server, or an explicitly selected deployed origin.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const origin = new URL(process.argv[2] || 'http://127.0.0.1:8791');
const request = path => fetch(new URL(path, origin), {
  redirect: 'manual', signal: AbortSignal.timeout(15000)
});
const links = await request('/.well-known/assetlinks.json');
assert.equal(links.status, 200);
assert.equal(links.headers.get('location'), null);
assert.match(links.headers.get('content-type'), /^application\/json\b/);
assert.deepEqual(await links.json(), JSON.parse(await readFile(new URL('.well-known/assetlinks.json', import.meta.url), 'utf8')));

const callback = await request('/android/oauth/callback?code=synthetic-private-code&state=synthetic-private-state');
assert.equal(callback.status, 200);
assert.equal(callback.headers.get('location'), null);
assert.match(callback.headers.get('cache-control'), /no-store/);
assert.match(callback.headers.get('referrer-policy'), /no-referrer/);
assert.match(callback.headers.get('content-type'), /^text\/(?:html|plain)\b/);
assert.doesNotMatch(await callback.text(), /synthetic-private|<script|https?:/i);
console.log('PASS: App Links JSON and exact OAuth callback HTTP checks (2 endpoints).');
