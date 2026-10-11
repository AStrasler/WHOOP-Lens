import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { escapeHtml, consentPreview, unavailable } from "../oauth/consent.mjs";
const file=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const auth=file("../oauth/auth-server/src/index.mjs");
const resource=file("../oauth/resource/src/index.mjs");
const authConfig=file("../oauth/auth-server/wrangler.jsonc");
const resourceConfig=file("../oauth/resource/wrangler.jsonc");
const packageJson=JSON.parse(file("../package.json"));

test("split OAuth server uses official 1.x SDK and pinned dependency",()=>{
  assert.equal(packageJson.dependencies["@cloudflare/workers-oauth-provider"],"1.2.3");
  assert.match(auth,/OAuthAuthorizationServer/);
  assert.match(resource,/OAuthResourceServer/);
  assert.match(auth,/clientIdMetadataDocumentEnabled:true/);
  assert.match(auth,/clientRegistrationEndpoint:"\/oauth\/register"/);
  assert.match(auth,/resources:\[RESOURCE\]/);
  assert.match(auth,/https:\/\/auth\.whooplens\.tech/);
  assert.match(auth,/https:\/\/whooplens\.tech\/mcp/);
  assert.match(resource,/authorization_servers:\["https:\/\/auth\.whooplens\.tech"\]/);
  assert.match(resource,/requiredScopes:\["mcp:read"\]/);
  assert.match(resource,/insufficientScope/);
});

test("inactive authorization cannot issue token or consent",async()=>{
  assert.match(auth,/OAUTH_SERVER_ENABLED!=="true"/);
  assert.match(auth,/status:503/);
  assert.doesNotMatch(auth,/completeAuthorization\s*\(/);
  assert.doesNotMatch(auth,/beginConsent\s*\(/);
  assert.match(auth,/authorizationPreview/);
  assert.match(auth,/parseAuthRequest\(request\)/);
  assert.match(auth,/describeConsent\(parsed\)/);
  const r=unavailable();
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,"WHOOP Lens OAuth staging not activated");
});

test("consent preview safely escapes all untrusted client metadata",()=>{
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
    "&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
  const html=consentPreview({
    clientName:'<script>alert("evil")</script>',
    redirectHost:'client.test"><iframe src=x>',
    clientDomain:"<b>bad</b>",
    scope:["mcp:read","<img src=x onerror=alert(1)>"],
    redirectIsLoopback:true
  });
  assert.match(html,/Redirect destination/);
  assert.match(html,/Verified client metadata domain/);
  assert.match(html,/computer/);
  assert.match(html,/authorization is not available yet/);
  assert.doesNotMatch(html,/<script>|<iframe|<img/);
  assert.doesNotMatch(html,/<form|<button|type='password'/);
  assert.match(html,/&#60;/);
});

test("Cloudflare auth storage and all routes remain disabled",()=>{
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
  for(const name of ["MCP_ENABLED","WHOOP_READS_ENABLED","MIGRATION_API_ENABLED"])
    assert.match(resourceConfig,new RegExp('"'+name+'"\\s*:\\s*"false"'));
  assert.match(resource,/activeMembership\(env\.DB,id\)/);
  assert.match(resource,/verifyIdentity:async\(\)=>id/);
  assert.doesNotMatch(resource,/verifySupabaseSession\(request/);
});
