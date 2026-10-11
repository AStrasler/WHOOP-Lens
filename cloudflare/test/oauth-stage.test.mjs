import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {escapeHtml,consentPage,unavailable} from '../oauth/consent.mjs';
const file=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const issuer=file('../oauth/auth-server/src/index.mjs');
const consent=file('../oauth/auth-server/src/consent-flow.mjs');
const resource=file('../oauth/resource/src/index.mjs');
const authConfig=file('../oauth/auth-server/wrangler.jsonc');
const resourceConfig=file('../oauth/resource/wrangler.jsonc');
const deps=JSON.parse(file('../package.json'));
test('official OAuth provider uses split issuer and resource audience',()=>{
  assert.equal(deps.dependencies['@cloudflare/workers-oauth-provider'],'1.2.3');
  assert.match(issuer,/OAuthAuthorizationServer/);
  assert.match(resource,/OAuthResourceServer/);
  assert.match(issuer,/clientIdMetadataDocumentEnabled:true/);
  assert.match(issuer,/clientRegistrationEndpoint:'\/oauth\/register'/);
  assert.match(issuer,/resources:\[RESOURCE\]/);
  assert.match(issuer,/https:\/\/auth\.whooplens\.tech/);
  assert.match(issuer,/https:\/\/whooplens\.tech\/mcp/);
  assert.match(resource,/authorization_servers:\["https:\/\/auth\.whooplens\.tech"\]/);
  assert.match(resource,/requiredScopes:\["mcp:read"\]/);
});
test('authorization cannot issue token with a disabled feature flag',async()=>{
  assert.match(issuer,/OAUTH_SERVER_ENABLED!=='true'/);
  assert.match(issuer,/OAUTH_CONSENT_ENABLED!=='true'/);
  assert.match(consent,/beginConsent\(auth\)/);
  assert.match(consent,/approveConsent\(request,handle/);
  assert.match(consent,/denyConsent\(request,handle\)/);
  assert.match(consent,/await oauth\.completeAuthorization/);
  const r=unavailable();assert.equal(r.status,503);
  assert.match(await r.text(),/not available/);
});
test('explicit consent escapes the client and redirect destination',()=>{
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
    '&#60;img src=x onerror=&#34;alert(1)&#34;&#62;');
  const html=consentPage({clientName:'<script>alert("evil")</script>',
    redirectHost:'client.test"><iframe src=x>',clientDomain:'<b>bad</b>',
    scope:['mcp:read','<img src=x onerror=alert(1)>'],redirectIsLoopback:true},'A'.repeat(43));
  assert.match(html,/access will be sent/i);
  assert.match(html,/Client metadata domain/);
  assert.match(html,/application on your computer/);
  assert.match(html,/Sign in and allow/);
  assert.doesNotMatch(html,/<script>|<iframe|<img/);
  assert.match(html,/name="decision" value="deny"/);
  assert.match(html,/&#60;/);
});
test('Cloudflare bindings and all public routes remain disabled',()=>{
  for(const cfg of [authConfig,resourceConfig]){
    assert.match(cfg,/"workers_dev"\s*:\s*false/);
    assert.match(cfg,/"preview_urls"\s*:\s*false/);
    assert.doesNotMatch(cfg,/"routes?"\s*:/);
    assert.doesNotMatch(cfg,/"custom_domain"\s*:/);
  }
  assert.match(authConfig,/"OAUTH_SERVER_ENABLED"\s*:\s*"false"/);
  assert.match(authConfig,/"OAUTH_CONSENT_ENABLED"\s*:\s*"false"/);
  assert.match(authConfig,/"global_fetch_strictly_public"/);
  assert.match(authConfig,/"binding"\s*:\s*"OAUTH_KV"/);
  assert.match(authConfig,/"binding"\s*:\s*"DB"/);
  assert.match(resourceConfig,/"OAUTH_RESOURCE_ENABLED"\s*:\s*"false"/);
  assert.match(resourceConfig,/"binding"\s*:\s*"AUTH_SERVER"/);
  assert.match(resourceConfig,/"service"\s*:\s*"whoop-lens-auth"/);
  for(const name of ['MCP_ENABLED','WHOOP_READS_ENABLED','MIGRATION_API_ENABLED'])
    assert.match(resourceConfig,new RegExp('"'+name+'"\\s*:\\s*"false"'));
  assert.match(resource,/activeMembership\(env\.DB,id\)/);
  assert.match(resource,/verifyIdentity:async\(\)=>id/);
});
