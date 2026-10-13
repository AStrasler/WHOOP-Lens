import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {escapeHtml,consentPage,noStoreHeaders,unavailable} from '../oauth/consent.mjs';
const file=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const issuer=file('../oauth/auth-server/src/index.mjs');
const consent=file('../oauth/auth-server/src/consent-flow.mjs');
const upstream=file('../oauth/auth-server/src/upstream.mjs');
const resource=file('../oauth/resource/src/index.mjs');
const authConfig=file('../oauth/auth-server/wrangler.jsonc');
const resourceConfig=file('../oauth/resource/wrangler.jsonc');
const deps=JSON.parse(file('../package.json'));

test('pinned official OAuth SDK and strict issuer/resource separation',()=>{
  assert.equal(deps.dependencies['@cloudflare/workers-oauth-provider'],'1.2.3');
  assert.match(issuer,/OAuthAuthorizationServer/);
  assert.match(issuer,/authorizationErrorRedirect/);
  assert.match(resource,/OAuthResourceServer/);
  assert.match(issuer,/clientIdMetadataDocumentEnabled:true/);
  assert.match(issuer,/clientRegistrationEndpoint:'\/oauth\/register'/);
  assert.match(issuer,/resources:\[RESOURCE\]/);
  assert.match(issuer,/https:\/\/auth\.whooplens\.tech/);
  assert.match(issuer,/https:\/\/whooplens\.tech\/mcp/);
  assert.match(resource,/authorization_servers:\["https:\/\/auth\.whooplens\.tech"\]/);
  assert.match(resource,/requiredScopes:\["mcp:read"\]/);
});

test('consent + OAuth issuer are disabled until independently approved',async()=>{
  assert.match(issuer,/OAUTH_SERVER_ENABLED!=='true'/);
  assert.match(issuer,/OAUTH_CONSENT_ENABLED!=='true'/);
  assert.match(issuer,/flow\.callback/);
  assert.match(consent,/oauth\.beginConsent\(original\)/);
  assert.match(consent,/oauth\.approveConsent\(request,handle/);
  assert.match(consent,/oauth\.denyConsent\(request,handle\)/);
  assert.match(consent,/oauth\.beginUpstream\(\{\.\.\.approved\.request,scope:\[\.\.\.selected\]\}/);
  assert.match(consent,/offlineOffered===false\)props\.connectorRefresh=true/);
  assert.match(consent,/oauth\.finishUpstream\(request\)/);
  assert.match(consent,/oauth\.completeAuthorization/);
  assert.match(consent,/connectorRefresh/);
  assert.match(issuer,/refreshGrantResult/);
  assert.match(issuer,/refreshTokenTTL:decision\.refreshTokenTTL/);
  const r=unavailable();
  assert.equal(r.status,503);
  assert.match(await r.text(),/not available/);
});

test('consent escapes hostile client metadata without collecting passwords',()=>{
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
    '&#60;img src=x onerror=&#34;alert(1)&#34;&#62;');
  const html=consentPage({
    clientName:'<script>alert(1)</script>',
    redirectHost:'client.test"><iframe src=x>',
    clientDomain:'<b>bad</b>',
    scope:['mcp:read','offline_access'],
    redirectIsLoopback:true
  },'H'.repeat(43));
  assert.match(html,/Access sent to/);
  assert.match(html,/class="verified"/);
  assert.match(html,/&#60;b&#62;bad&#60;\/b&#62;/);
  assert.match(html,/application on your computer/);
  assert.match(html,/Continue to secure sign-in/);
  assert.match(html,/name="scope" value="mcp:read"/);
  assert.match(html,/name="scope" value="offline_access"/);
  assert.doesNotMatch(html,/<script>|<iframe|<img|fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(html,/type="password"|name="password"|name="email"/);
  assert.match(html,/name="decision" value="deny"/);
  const deny=html.split('<form').find(part=>part.includes('value="deny"'));
  assert.ok(deny);
  assert.doesNotMatch(deny,/name="scope"/);
  assert.match(html,/&#60;/);
  const style=html.match(/<style>([\s\S]*)<\/style>/)[1];
  const digest=createHash('sha256').update(style).digest('base64');
  const htmlCsp=noStoreHeaders('text/html; charset=utf-8')['content-security-policy'];
  assert.ok(htmlCsp.includes("style-src 'sha256-"+digest+"'"));
  assert.match(htmlCsp,/form-action 'self' https:\/\/auth\.whooplens\.tech https:\/\/whoop-lens\.cloudflareaccess\.com https:\/\/chatgpt\.com/);
  assert.doesNotMatch(noStoreHeaders()['content-security-policy'],/style-src|fonts\.googleapis/);
  assert.doesNotMatch(consent,/password\s*[:=]/);
  assert.doesNotMatch(upstream,/grant_type=password/);
});

test('both Workers have all launch gates off and no public route',()=>{
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
  for(const name of ['MCP_ENABLED','WHOOP_READS_ENABLED','MIGRATION_API_ENABLED','WEB_HEALTH_IMPORT_ENABLED'])
    assert.match(resourceConfig,new RegExp('"'+name+'"\\s*:\\s*"false"'));
  assert.match(resource,/activeMembership\(env\.DB,id\)/);
  assert.match(resource,/verifyIdentity:async\(\)=>id/);
});

test('consent HTML uses same-origin referrer policy without weakening POST CSRF',async()=>{
  const {makeConsentFlow}=await import('../oauth/auth-server/src/consent-flow.mjs');
  const flow=makeConsentFlow({getOAuth:()=>({
    parseAuthRequest:async()=>({scope:['mcp:read']}),
    describeConsent:async()=>({clientName:'Synthetic',redirectHost:'chatgpt.com',scope:['mcp:read']}),
    beginConsent:async()=>({handle:'A'.repeat(43),headers:new Headers({
      'set-cookie':'__Host-oauth-consent=synthetic; Path=/; Secure; HttpOnly'
    })})
  })});
  const env={OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true'};
  const get=await flow.authorize(new Request('https://auth.whooplens.tech/authorize'),env);
  assert.equal(get.status,200);
  assert.equal(get.headers.get('referrer-policy'),'same-origin');
  assert.match(get.headers.get('content-security-policy'),
    /form-action 'self' https:\/\/auth\.whooplens\.tech https:\/\/whoop-lens\.cloudflareaccess\.com https:\/\/chatgpt\.com/);
  assert.match(get.headers.get('set-cookie'),/__Host-oauth-consent/);
  const badPost=await flow.authorize(new Request('https://auth.whooplens.tech/authorize',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
      origin:'null','sec-fetch-site':'same-origin'},
    body:new URLSearchParams({handle:'A'.repeat(43),decision:'approve',scope:'mcp:read'})
  }),env);
  assert.equal(badPost.status,403);
  const foreignPost=await flow.authorize(new Request('https://auth.whooplens.tech/authorize',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
      origin:'https://other.invalid','sec-fetch-site':'cross-site'},
    body:new URLSearchParams({handle:'A'.repeat(43),decision:'approve',scope:'mcp:read'})
  }),env);
  assert.equal(foreignPost.status,403);
  const sameSite=await flow.authorize(new Request('https://auth.whooplens.tech/authorize',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
      origin:'https://auth.whooplens.tech','sec-fetch-site':'same-site'},
    body:new URLSearchParams({handle:'A'.repeat(43),decision:'approve',scope:'mcp:read'})
  }),env);
  assert.equal(sameSite.status,400);
  const sameSiteForeign=await flow.authorize(new Request('https://auth.whooplens.tech/authorize',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
      origin:'https://whooplens.tech','sec-fetch-site':'same-site'},
    body:new URLSearchParams({handle:'A'.repeat(43),decision:'approve',scope:'mcp:read'})
  }),env);
  assert.equal(sameSiteForeign.status,403);
});
