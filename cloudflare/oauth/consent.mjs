// The official OAuth provider owns the browser-bound one-time consent cookie.
// Cloudflare NEVER requests or receives account passwords in this design.
export function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>'&#'+ch.charCodeAt(0)+';');
}
export function consentPage(details,handle){
  const client=escapeHtml(details.clientName||'Unknown application');
  const host=escapeHtml(details.redirectHost||'unknown');
  const domain=details.clientDomain?escapeHtml(details.clientDomain):null;
  const scopes=Array.isArray(details.scope)?details.scope.filter(s=>
    s==='mcp:read'||s==='offline_access'):[];
  const requested=scopes.map(s=>'<label><input type="checkbox" name="scope" value="'+
    escapeHtml(s)+'" checked> '+escapeHtml(s)+'</label>').join(' ');
  const safeHandle=escapeHtml(handle);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>WHOOP Lens authorization</title></head><body><main>'+
    '<h1>Authorize WHOOP Lens access?</h1>'+
    '<p><strong>'+client+'</strong> is requesting access to your WHOOP Lens data.</p>'+
    (domain?'<p>Verified client metadata domain: <strong>'+domain+'</strong>.</p>':
      '<p>The client supplied its own name; that name is not verified.</p>')+
    '<p>After approval, access will be sent to <strong>'+host+'</strong>.</p>'+
    (details.redirectIsLoopback?'<p><strong>Warning:</strong> The redirect goes to an application on your computer. Approve only if you initiated the connection.</p>':'')+
    '<form method="post" action="/authorize">'+
    '<input type="hidden" name="handle" value="'+safeHandle+'">'+
    '<fieldset><legend>Permissions you approve</legend>'+requested+'</fieldset>'+
    '<p>Continue to the existing WHOOP Lens identity provider to sign in. This Cloudflare page does not collect your password.</p>'+
    '<button name="decision" value="approve">Continue to secure sign-in</button></form>'+
    '<form method="post" action="/authorize">'+
    '<input type="hidden" name="handle" value="'+safeHandle+'">'+
    '<button name="decision" value="deny">Cancel</button></form>'+
    '<p>Only invited and active WHOOP Lens members can finish connecting.</p>'+
    '</main></body></html>';
}
export function noStoreHeaders(contentType='text/plain; charset=utf-8'){
  return {'content-type':contentType,'cache-control':'no-store',
    'content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'x-content-type-options':'nosniff'};
}
export function unavailable(){
  return new Response('WHOOP Lens authorization not available',{status:503,headers:noStoreHeaders()});
}
