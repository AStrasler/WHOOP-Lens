import test from 'node:test';
import assert from 'node:assert/strict';
import {oauthErrorEvent,logOAuthError,logOAuthStage} from '../oauth/auth-server/src/oauth-diagnostics.mjs';

test('OAuth diagnostics preserve fixed failure reasons and discard credentials and arbitrary text',t=>{
  const lines=[];
  t.mock.method(console,'warn',v=>lines.push(v));
  logOAuthError({code:'invalid_grant',description:'Bearer secret',
    internal:{category:'refresh-token-grant',reason:'refresh_token_expired',detail:'secret'},request:'secret',headers:{cookie:'secret'}});
  assert.deepEqual(JSON.parse(lines[0]),{event:'oauth_failure',code:'invalid_grant',category:'refresh-token-grant',reason:'refresh_token_expired'});
  assert.deepEqual(oauthErrorEvent({code:'secret',internal:{reason:'secret'}}),
    {event:'oauth_failure',code:'other',category:'other',reason:'other'});
  assert.ok(!lines.join('').includes('secret'));
});
test('OAuth stage logging requires explicit capture and an allowlisted stage',t=>{
  const lines=[];
  t.mock.method(console,'log',v=>lines.push(v));
  logOAuthStage({},'refresh_token_allowed');
  logOAuthStage({DIAGNOSTICS_CAPTURE_ENABLED:'true'},'secret');
  assert.equal(lines.length,0);
  logOAuthStage({DIAGNOSTICS_CAPTURE_ENABLED:'true'},'refresh_token_allowed');
  assert.deepEqual(JSON.parse(lines[0]),{event:'oauth_stage',stage:'refresh_token_allowed'});
});

test('metadata outages are retryable without a credential rejection or leaked detail',t=>{
  t.mock.method(console,'warn',()=>{});
  const response=logOAuthError({code:'invalid_client',description:'secret',
    internal:{category:'client-id-metadata-document',reason:'metadata_resolution_failed',detail:'secret'}});
  assert.equal(response.status,503);
  assert.equal(response.headers.get('retry-after'),'60');
  assert.equal(response.headers.get('www-authenticate'),null);
  return response.json().then(body=>{
    assert.equal(body.error,'temporarily_unavailable');
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.equal(logOAuthError({code:'invalid_client',internal:{category:'client-authentication',reason:'client_secret_mismatch'}}),undefined);
  });
});


test('authorization diagnostics identify fixed stages/reasons without retaining error or request text',async t=>{
  const {authorizationFailureEvent,logAuthorizationFailure}=await import('../oauth/auth-server/src/oauth-diagnostics.mjs');
  const cases=[
    ['authorize_request',{description:'Invalid client_id'},'client_unavailable'],
    ['authorize_request',{description:'Invalid redirect URI'},'redirect_rejected'],
    ['consent_approval',{description:'This authorization expired or was already used; start again'},'transaction_expired_or_replayed'],
    ['consent_session',Error('private-cookie-and-token'),'dependency_unavailable'],
    ['upstream_identity_failed',Error('private-cookie-and-token'),'identity_rejected'],
  ];
  const lines=[];t.mock.method(console,'warn',v=>lines.push(v));
  for(const [stage,error,reason] of cases){
    const event=authorizationFailureEvent(stage,{...error,request:'private-cookie-and-token',url:'private-cookie-and-token'});
    assert.deepEqual(event,{event:'oauth_authorization_failure',stage,reason});
    logAuthorizationFailure({DIAGNOSTICS_CAPTURE_ENABLED:'true'},stage,error);
  }
  logAuthorizationFailure({},'authorize_request',Error('private-cookie-and-token'));
  assert.equal(lines.length,cases.length);
  assert.ok(!lines.join('').includes('private-cookie-and-token'));
  assert.deepEqual(authorizationFailureEvent('private-cookie-and-token',{},'private-cookie-and-token'),
    {event:'oauth_authorization_failure',stage:'other',reason:'dependency_unavailable'});
});


test('missing callback state is diagnosed without touching the provider or logging callback fields',async t=>{
  const {makeConsentFlow}=await import('../oauth/auth-server/src/consent-flow.mjs');
  const lines=[];t.mock.method(console,'warn',v=>lines.push(JSON.parse(v)));
  const flow=makeConsentFlow({getOAuth:()=>{throw Error('Must not load missing state');}});
  const response=await flow.callback(new Request('https://auth.whooplens.tech/oauth/upstream/callback?code=synthetic-private'),
    {OAUTH_SERVER_ENABLED:'true',OAUTH_CONSENT_ENABLED:'true',DIAGNOSTICS_CAPTURE_ENABLED:'true'});
  assert.equal(response.status,400);
  assert.deepEqual(lines,[{event:'oauth_authorization_failure',stage:'upstream_state_failed',reason:'request_rejected'}]);
});
