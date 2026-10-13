import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

// Workers runtime only accepts "follow" and "manual" as fetch redirect modes.
// These checks prevent an OAuth identity outage during Access JWK retrieval.
const source=readFileSync(new URL('../oauth/auth-server/src/upstream.mjs',import.meta.url),'utf8');
test('Cloudflare Access certificate fetch uses the supported manual redirect mode',()=>{
  assert.match(source,/issuer\+'\/cdn-cgi\/access\/certs'[\s\S]{0,120}redirect:'manual'/);
  assert.doesNotMatch(source,/redirect:'error'/);
});
test('certificate fetch fails closed for any redirect, oversized body, or non-OK response',()=>{
  assert.match(source,/if\(!response\.ok\|\|Number\(response\.headers\.get\('content-length'\)\)>65536\)/);
  assert.match(source,/if\(body\.length>65536\)/);
  assert.match(source,/issuer\+'\/cdn-cgi\/access\/certs'/);
});
