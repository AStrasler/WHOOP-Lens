// OAuth's official beginConsent/approveConsent helpers own the browser-bound
// handle, the one-time cookie and the validated redirect and scope request.
export function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>'&#'+ch.charCodeAt(0)+';');
}
export function consentPage(details,handle){
  const client=escapeHtml(details.clientName||'Unknown application');
  const host=escapeHtml(details.redirectHost||'unknown');
  const domain=details.clientDomain?escapeHtml(details.clientDomain):null;
  const scopes=Array.isArray(details.scope)?details.scope.filter(s=>s==='mcp:read'||s==='offline_access'):[];
  const requested=scopes.map(s=>'<label><input type="checkbox" name="scope" value="'+escapeHtml(s)+'" checked> '+escapeHtml(s)+'</label>').join(' ');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>WHOOP Lens authorization</title></head><body><main><h1>Authorize WHOOP Lens access?</h1>'+
    '<p><strong>'+client+'</strong> is requesting access to your WHOOP Lens data.</p>'+
    (domain?'<p>Client metadata domain: <strong>'+domain+'</strong>.</p>':'<p>The client supplied its own name; that name is not verified.</p>')+
    '<p>After approval, access will be sent to <strong>'+host+'</strong>.</p>'+
    (details.redirectIsLoopback?'<p><strong>Warning:</strong> The redirect goes to an application on your computer. Approve only if you initiated the connection.</p>':'')+
    '<form method="post" action="/authorize" autocomplete="on">'+
    '<input type="hidden" name="handle" value="'+escapeHtml(handle)+'">'+
    '<fieldset><legend>Permissions you approve</legend>'+requested+'</fieldset>'+
    '<p>Sign in with your existing WHOOP Lens (Supabase) account to confirm your identity. Credentials are checked with Supabase and are not stored on Cloudflare.</p>'+
    '<label>Email <input type="email" name="email" autocomplete="username" required maxlength="320"></label>'+
    '<label>Password <input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label>'+
    '<p><button name="decision" value="approve">Sign in and allow</button> <button name="decision" value="deny" formnovalidate>Cancel</button></p>'+
    '</form><p>Only explicitly invited and active WHOOP Lens accounts may connect.</p></main></body></html>';
}
export function noStoreHeaders(contentType='text/plain; charset=utf-8'){
  return {'content-type':contentType,'cache-control':'no-store',
    'content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'x-content-type-options':'nosniff'};
}
export function unavailable(){return new Response('WHOOP Lens authorization not available',{status:503,headers:noStoreHeaders()});}
