// HTML-safe, deliberately INACTIVE consent preview.
// No buttons or credentials. The independent identity/consent flow is unimplemented.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch=>"&#"+ch.charCodeAt(0)+";");
}
export function consentPreview(details) {
  const client=escapeHtml(details.clientName||"Unknown application");
  const host=escapeHtml(details.redirectHost||"unknown");
  const domain=details.clientDomain?escapeHtml(details.clientDomain):null;
  const scopes=Array.isArray(details.scope)?details.scope.map(escapeHtml):[];
  const blocks=[
    "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<title>WHOOP Lens OAuth: not active</title></head><body><main>",
    "<h1>WHOOP Lens authorization is not available yet</h1>",
    "<p><strong>"+client+"</strong> requested access.</p>",
    "<p>Redirect destination: <strong>"+host+"</strong></p>",
    domain?"<p>Verified client metadata domain: "+domain+"</p>":
      "<p>This app registered itself; its name is not independently verified.</p>",
    details.redirectIsLoopback?"<p><strong>Warning:</strong> the redirect goes to an app on your computer.</p>":"",
    "<p>Requested permissions: "+(scopes.join(", ")||"none")+"</p>",
    "<p>No authorization can be approved or token issued while migration staging is disabled.</p>",
    "</main></body></html>"
  ];
  return blocks.join("");
}
export function unavailable() {
  return Response.json({error:"WHOOP Lens OAuth staging not activated"},{
    status:503,headers:{"cache-control":"no-store","content-security-policy":"default-src 'none'",
      "referrer-policy":"no-referrer","x-content-type-options":"nosniff"}
  });
}
