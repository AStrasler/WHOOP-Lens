import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {build, OUT, PAGES, STATIC} from './build.mjs';

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p)); else out.push(p);
  }
  return out;
}

test('www site output is limited to the public pages and assets', async () => {
  await build();
  const list = (await files(OUT)).map(f => relative(OUT, f).replaceAll('\\', '/')).sort();
  assert.deepEqual(list, [...PAGES, ...STATIC, 'logo.jpg', 'style.css', 'connect.css'].sort());
});

test('www site output has no GitHub Pages prefix, Supabase, or dashboard', async () => {
  await build();
  for (const f of await files(OUT)) {
    if (f.endsWith('.jpg')) continue;
    const text = await readFile(f, 'utf8');
    assert.doesNotMatch(text, /["'(=]\/WHOOP-Lens\//, f); // root-relative GitHub Pages prefix
    assert.doesNotMatch(text, /supabase/i, f);
    assert.doesNotMatch(text, /dashboard/i, f);
    assert.doesNotMatch(text, /<script/i, f);
  }
  const privacy = await readFile(join(OUT, 'privacy/index.html'), 'utf8');
  assert.match(privacy, /https:\/\/www\.whooplens\.tech\/privacy\//);
});

test('www site headers set CSP, nosniff, referrer policy, and frame-ancestors none', async () => {
  await build();
  const h = await readFile(join(OUT, '_headers'), 'utf8');
  assert.match(h, /Content-Security-Policy: default-src 'none';[^\n]*frame-ancestors 'none'/);
  assert.match(h, /X-Content-Type-Options: nosniff/);
  assert.match(h, /Referrer-Policy: no-referrer/);
});

test('www landing page keeps the https seat request link', async () => {
  await build();
  const landing = await readFile(join(OUT, 'index.html'), 'utf8');
  assert.match(landing, /href="https:\/\/auth\.whooplens\.tech\/request-seat"/);
});

test('published App Links use the signing certificate and fallback never reflects callback data', async () => {
  await build();
  const links = JSON.parse(await readFile(join(OUT, '.well-known/assetlinks.json'), 'utf8'));
  assert.deepEqual(links, [{relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'io.github.astrasler.whooplens',
    sha256_cert_fingerprints: ['C3:E4:F5:6D:7E:BC:66:32:95:85:19:7C:49:26:35:FF:B4:57:E7:C0:D0:D2:73:E1:6F:16:A4:3E:72:CC:F5:78']
  }}]);
  const fallback = await readFile(join(OUT, 'android/oauth/callback.html'), 'utf8');
  assert.doesNotMatch(fallback, /<script|https?:|http-equiv=["']refresh/i);
  assert.match(fallback, /restart sign-in/);
  const headers = await readFile(join(OUT, '_headers'), 'utf8');
  assert.match(headers, /\/\.well-known\/assetlinks\.json\s+Content-Type: application\/json/);
  assert.match(headers, /\/android\/oauth\/callback\*\s+Cache-Control: no-store/);
});

test('every published HTML page visibly identifies the independent project', async () => {
  await build();
  for (const page of PAGES) {
    const html = await readFile(join(OUT, page), 'utf8');
    assert.match(html, /<main[^>]*>\s*<aside class="independence-notice"/, page);
    assert.match(html, /PRIVATE, INDEPENDENT PROJECT/, page);
    assert.match(html, /not owned, operated, sponsored, endorsed by, or affiliated with WHOOP/, page);
    assert.match(html, /developer API with each user's authorization/, page);
  }
  const style = await readFile(join(OUT, 'style.css'), 'utf8');
  const connect = await readFile(join(OUT, 'connect.css'), 'utf8');
  for (const css of [style, connect]) assert.match(css, /\.independence-notice\s*\{/);
});
