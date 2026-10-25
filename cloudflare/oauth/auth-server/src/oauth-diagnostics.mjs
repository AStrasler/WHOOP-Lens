// Never log the SDK's description, detail, request, headers or token values.
// Unknown reasons collapse to a fixed label, including after SDK upgrades.
const REASONS=new Set([
  'grant_not_found','refresh_token_malformed','refresh_token_missing',
  'refresh_token_mismatch','refresh_token_expired','client_mismatch',
  'code_missing','code_malformed','code_mismatch','code_replayed','code_verifier_missing','code_verifier_mismatch',
  'scope_not_granted','callback_error','grant_type_not_registered',
  'client_not_found','client_secret_missing','client_secret_not_registered','client_secret_mismatch',
  'client_assertion_incomplete','client_assertion_invalid','client_assertion_type_unsupported',
  'metadata_resolution_failed','client_id_missing','token_endpoint_auth_method_mismatch',
  'kv_rate_limited','resource_invalid','resource_not_configured','grant_audience_unbound',
  'resource_grant_mismatch','legacy_grant_resource_mismatch'
]);
export function oauthErrorEvent(error){
  const reason=REASONS.has(error?.internal?.reason)?error.internal.reason:'other';
  const categories=new Set(['authorization-code-grant','refresh-token-grant','token-exchange-callback',
    'token-issuance','client-authentication','client-registration','client-id-metadata-document','cimd']);
  const category=categories.has(error?.internal?.category)?error.internal.category:'other';
  const codes=new Set(['invalid_grant','invalid_client','invalid_scope','invalid_request',
    'invalid_target','unauthorized_client','temporarily_unavailable','server_error']);
  return {event:'oauth_failure',code:codes.has(error?.code)?error.code:'other',category,reason};
}
export function logOAuthError(error){
  console.warn(JSON.stringify(oauthErrorEvent(error)));
  // A failed metadata lookup does not invalidate the client's credentials.
  // Keep existing grants intact and tell the client to retry, rather than
  // treating an upstream outage as a permanent invalid_client response.
  if(error?.internal?.category==='client-id-metadata-document'&&
     error?.internal?.reason==='metadata_resolution_failed')
    return Response.json({error:'temporarily_unavailable',
      error_description:'Client metadata is temporarily unavailable; retry shortly.'},
      {status:503,headers:{'cache-control':'no-store','pragma':'no-cache','retry-after':'60'}});
}
export function logOAuthStage(env,stage){
  if(env?.DIAGNOSTICS_CAPTURE_ENABLED!=='true')return;
  if(!['authorization_code_allowed','refresh_token_allowed','refresh_permission_denied',
    'upstream_state_failed','upstream_identity_failed','authorization_completion_failed',
    'authorization_completed'].includes(stage))return;
  console.log(JSON.stringify({event:'oauth_stage',stage}));
}

// Consent errors bypass the provider's token onError hook. Record fixed labels,
// never request URLs, form fields, cookies, exception messages or client IDs.
const AUTHORIZATION_STAGES=new Set([
  'authorize_request','authorize_scope','consent_description','consent_session',
  'consent_origin','consent_form','upstream_configuration','consent_approval',
  'consent_selection','upstream_session','upstream_redirect',
  'upstream_state_failed','upstream_identity_failed','authorization_completion_failed'
]);
const AUTHORIZATION_REASONS=new Set([
  'request_rejected','scope_rejected','origin_rejected','form_rejected',
  'client_missing','client_unavailable','redirect_rejected','transaction_unbound',
  'transaction_mismatch','transaction_expired_or_replayed','dependency_unavailable',
  'validation_rejected','identity_rejected'
]);
const SAFE_DESCRIPTIONS=new Map([
  ['client_id is required','client_missing'],
  ['Invalid client_id','client_unavailable'],
  ['Invalid redirect URI','redirect_rejected'],
  ['This authorization was not started in this browser; start again','transaction_unbound'],
  ['This authorization belongs to a different browser session; start again','transaction_mismatch'],
  ['This authorization expired or was already used; start again','transaction_expired_or_replayed']
]);
export function authorizationFailureEvent(stage,error,reason){
  const safeStage=AUTHORIZATION_STAGES.has(stage)?stage:'other';
  const safeReason=AUTHORIZATION_REASONS.has(reason)?reason:
    SAFE_DESCRIPTIONS.get(error?.description) ||
    (error?.name==='AuthorizationError'?'validation_rejected':
      safeStage==='upstream_identity_failed'?'identity_rejected':'dependency_unavailable');
  return {event:'oauth_authorization_failure',stage:safeStage,reason:safeReason};
}
export function logAuthorizationFailure(env,stage,error,reason){
  if(env?.DIAGNOSTICS_CAPTURE_ENABLED!=='true')return;
  console.warn(JSON.stringify(authorizationFailureEvent(stage,error,reason)));
}
