import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthClient, MCP_URL, AUTH_URL } from '../docs/auth-client.mjs';

test('Cloudflare endpoints', () => {
  assert.equal(MCP_URL, 'https://whooplens.tech/mcp');
  assert.equal(AUTH_URL, 'https://auth.whooplens.tech');
});

test('legacy client is disabled', () => {
  const client = createAuthClient();
  for (const method of ['signIn','signOut','details','decide','status','connect']) {
    assert.throws(() => client[method](), /Legacy sign-in is retired/);
  }
});
