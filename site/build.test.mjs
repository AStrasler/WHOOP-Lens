import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {build, OUT, PAGES} from './build.mjs';

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
  assert.deepEqual(list, [...PAGES, '404.html', '_headers', 'logo.jpg', 'style.css'].sort());
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
