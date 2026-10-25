// The official OAuth provider owns the browser-bound one-time consent cookie.
// Cloudflare NEVER requests or receives account passwords in this design.
// The consent document is self-contained: no third-party fonts or scripts.
export function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>'&#'+ch.charCodeAt(0)+';');
}
const SCOPE_COPY={
  'mcp:read':['mcp:read','Read your WhoopLens data through MCP'],
  'offline_access':['offline_access','Stay connected without approving again each time']
};
export const CONSENT_CSS=`  :root {
    --bg: #0b1418;
    --bg-2: #0f1c21;
    --card: #132228;
    --card-edge: #1e333a;
    --teal: #4fd8cf;
    --teal-dim: #2a8f89;
    --teal-glow: rgba(79, 216, 207, 0.28);
    --text: #eef6f5;
    --muted: #8aa3a6;
    --faint: #5c7579;
    --danger: #ff6b6b;
    --radius: 18px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: "Inter", system-ui, -apple-system, Segoe UI, sans-serif;
    background:
      radial-gradient(900px 500px at 50% -10%, rgba(79,216,207,0.10), transparent 60%),
      linear-gradient(180deg, var(--bg-2), var(--bg));
    color: var(--text);
    display: grid;
    place-items: center;
    padding: 32px 16px;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 420px;
    background: linear-gradient(180deg, var(--card), #101d22);
    border: 1px solid var(--card-edge);
    border-radius: 24px;
    padding: 36px 28px 28px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.03);
  }
  .mark {
    width: 84px; height: 84px;
    margin: 0 auto 22px;
    border-radius: 22px;
    background: linear-gradient(160deg, #1a2a30, #0c171b);
    border: 1px solid #22383f;
    display: grid; place-items: center;
    box-shadow: 0 0 0 6px rgba(79,216,207,0.04), 0 10px 30px rgba(0,0,0,0.4);
  }
  .mark svg { width: 62px; height: 62px; filter: drop-shadow(0 0 8px var(--teal-glow)); }
  .pulse-line {
    stroke-dasharray: 120;
    stroke-dashoffset: 120;
    animation: trace 2.4s ease-in-out infinite;
  }
  @keyframes trace {
    0% { stroke-dashoffset: 120; }
    45%, 70% { stroke-dashoffset: 0; }
    100% { stroke-dashoffset: -120; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse-line, .dots i { animation: none; }
    .pulse-line { stroke-dashoffset: 0; }
  }
  h1 {
    font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
    text-align: center; line-height: 1.25;
  }
  h1 span { color: var(--teal); }
  .lede {
    margin-top: 8px; text-align: center;
    color: var(--muted); font-size: 14.5px; line-height: 1.5;
  }
  .lede strong { color: var(--text); font-weight: 600; }
  .link {
    margin: 24px 0 20px;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  }
  .node {
    width: 44px; height: 44px; border-radius: 12px;
    display: grid; place-items: center;
    background: #0e1a1e; border: 1px solid var(--card-edge);
    font-weight: 700; font-size: 13px; color: var(--muted);
  }
  .node.lens { border-color: var(--teal-dim); }
  .node.lens svg { width: 28px; height: 28px; }
  .dots { display: flex; gap: 5px; }
  .dots i {
    width: 5px; height: 5px; border-radius: 50%; background: var(--teal-dim);
    animation: blink 1.4s infinite ease-in-out;
  }
  .dots i:nth-child(2) { animation-delay: .2s; }
  .dots i:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%,100% { opacity: .25; } 50% { opacity: 1; background: var(--teal); } }
  .details {
    border: 1px solid var(--card-edge);
    border-radius: 14px;
    overflow: hidden;
  }
  .row {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 12px 14px; font-size: 13.5px;
  }
  .row + .row { border-top: 1px solid var(--card-edge); }
  .row .k { color: var(--faint); }
  .row .v {
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px;
    color: var(--text); text-align: right; word-break: break-all;
  }
  .verified {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--teal); font-family: "Inter", sans-serif; font-size: 11.5px; font-weight: 600;
    margin-left: 6px;
  }
  fieldset { border: 0; margin-top: 20px; }
  legend {
    font-size: 11.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--faint); margin-bottom: 10px;
  }
  .scope {
    display: flex; align-items: center; gap: 12px;
    padding: 13px 14px; border-radius: 12px;
    background: rgba(79,216,207,0.06); border: 1px solid rgba(79,216,207,0.22);
    cursor: pointer;
  }
  .scope + .scope { margin-top: 8px; }
  .scope input { appearance: none; width: 20px; height: 20px; flex: none;
    border-radius: 6px; border: 1.5px solid var(--teal-dim); display: grid; place-items: center; cursor: pointer; }
  .scope input:checked { background: var(--teal); border-color: var(--teal); }
  .scope input:checked::after {
    content: ""; width: 10px; height: 6px; margin-top: -2px;
    border-left: 2px solid #062023; border-bottom: 2px solid #062023; transform: rotate(-45deg);
  }
  .scope input:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
  .scope .name { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; font-weight: 500; }
  .scope .desc { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .note, .warn, .unverified {
    margin-top: 18px; color: var(--muted); font-size: 12.5px; line-height: 1.5;
  }
  .note { display: flex; gap: 10px; align-items: flex-start; }
  .note svg { flex: none; margin-top: 1px; }
  .warn {
    padding: 12px 14px; border-radius: 12px;
    background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.35);
    color: var(--text); font-size: 13px;
  }
  .actions { margin-top: 22px; display: grid; gap: 10px; }
  button {
    font: inherit; font-weight: 600; font-size: 15px; width: 100%;
    padding: 14px 16px; border-radius: 12px; cursor: pointer;
    transition: transform .08s ease, box-shadow .2s ease, background .2s ease;
  }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
  .primary {
    border: 0; color: #052023;
    background: linear-gradient(180deg, #6ae6dd, var(--teal));
    box-shadow: 0 8px 24px var(--teal-glow), inset 0 1px 0 rgba(255,255,255,0.35);
  }
  .primary:hover { box-shadow: 0 10px 32px rgba(79,216,207,0.42), inset 0 1px 0 rgba(255,255,255,0.35); }
  .ghost {
    background: transparent; color: var(--muted);
    border: 1px solid var(--card-edge);
  }
  .ghost:hover { color: var(--text); border-color: #2c464e; }
  form.cancel { margin-top: 10px; }
  footer {
    margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--card-edge);
    text-align: center; color: var(--faint); font-size: 12px; line-height: 1.5;
  }
`;
// SHA-256 of CONSENT_CSS. The consent document allows this stylesheet and nothing else.
const CONSENT_STYLE_HASH='sha256-vOPH/gT8r1ztOcNPlc90KgyEgfKLxKHeCQj/k4twcL8=';
const MARK=`<svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="27" stroke="#4fd8cf" stroke-width="4"/><path class="pulse-line" d="M8 33h13l3-5 4 12 5-20 4 15 3-2h12" stroke="#eef6f5" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="56" cy="33" r="2.6" fill="#4fd8cf"/></svg>`;
const LENS=`<svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="26" stroke="#4fd8cf" stroke-width="5"/><path d="M10 33h12l3-5 4 12 5-20 4 15 3-2h11" stroke="#eef6f5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOCK=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2" stroke="#4fd8cf" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" stroke="#4fd8cf" stroke-width="2"/></svg>`;
const CHECK=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function clientMark(name){
  const clean=String(name||'').replace(/[^A-Za-z0-9]+/g,' ').trim();
  if(/^chat\s*gpt$/i.test(clean))return 'GPT';
  const parts=clean.split(/\s+/).filter(Boolean);
  const letters=parts.length>1?parts.map(part=>part[0]).join(''):(parts[0]||'App');
  return escapeHtml(letters.slice(0,3).toUpperCase());
}
function scopeFields(scope){
  const scopes=Array.isArray(scope)?scope.filter(name=>Object.hasOwn(SCOPE_COPY,name)):[];
  return scopes.map(name=>{
    const [label,desc]=SCOPE_COPY[name];
    return '<label class="scope"><input type="checkbox" name="scope" value="'+escapeHtml(name)+
      '" checked><span><span class="name">'+escapeHtml(label)+'</span><span class="desc">'+
      escapeHtml(desc)+'</span></span></label>';
  }).join('');
}
export function consentPage(details,handle){
  const client=escapeHtml(details.clientName||'Unknown application');
  const host=escapeHtml(details.redirectHost||'unknown');
  const domain=details.clientDomain?escapeHtml(details.clientDomain):null;
  const safeHandle=escapeHtml(handle);
  const domainRow=domain
    ? '<div class="row"><span class="k">Client domain</span><span class="v">'+domain+
      '<span class="verified">'+CHECK+'Verified</span></span></div>'
    : '<div class="row"><span class="k">Client domain</span><span class="v">Not verified</span></div>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<meta name="color-scheme" content="dark">'+
    '<title>Authorize WhoopLens</title><style>'+CONSENT_CSS+'</style></head><body><main>'+
    '<div class="mark" aria-hidden="true">'+MARK+'</div>'+
    '<h1>Authorize <span>WhoopLens</span> access?</h1>'+
    '<p class="lede"><strong>'+client+'</strong> is requesting access to your WhoopLens data.</p>'+
    '<div class="link" aria-hidden="true"><div class="node">'+clientMark(details.clientName)+'</div>'+
    '<div class="dots"><i></i><i></i><i></i></div><div class="node lens">'+LENS+'</div></div>'+
    '<div class="details">'+domainRow+
    '<div class="row"><span class="k">Access sent to</span><span class="v">'+host+'</span></div></div>'+
    (domain?'':'<p class="unverified">The client supplied its own name; that name is not verified.</p>')+
    (details.redirectIsLoopback?'<p class="warn"><strong>Warning:</strong> The redirect goes to an application on your computer. Approve only if you initiated the connection.</p>':'')+
    '<form method="post" action="/authorize">'+
    '<input type="hidden" name="handle" value="'+safeHandle+'">'+
    '<fieldset><legend>Permissions you approve</legend>'+scopeFields(details.scope)+'</fieldset>'+
    '<div class="note">'+LOCK+'<span>You\'ll continue to the existing WhoopLens identity provider to sign in. This page never collects your password.</span></div>'+
    '<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Continue to secure sign-in</button></div></form>'+
    '<form class="cancel" method="post" action="/authorize">'+
    '<input type="hidden" name="handle" value="'+safeHandle+'">'+
    '<button class="ghost" type="submit" name="decision" value="deny">Cancel</button></form>'+
    '<footer>Only invited, active WhoopLens members can finish connecting.</footer>'+
    '</main></body></html>';
}
export function noStoreHeaders(contentType='text/plain; charset=utf-8'){
  // Chrome treats the whole redirect chain of a form POST as the form target.
  // After approval the browser must be able to follow the same-origin callback
  // through to the Cloudflare Access login host. 'self' alone aborts that hop,
  // drops the authorize query, and the next load is "Authorization unavailable".
  const style=String(contentType).startsWith('text/html')?" style-src '"+CONSENT_STYLE_HASH+"';":'';
  return {'content-type':contentType,'cache-control':'no-store',
    'content-security-policy':"default-src 'none';"+style+" form-action 'self' https://auth.whooplens.tech https://whoop-lens.cloudflareaccess.com https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'x-content-type-options':'nosniff'};
}
export function unavailable(){
  return new Response('WhoopLens authorization not available',{status:503,headers:noStoreHeaders()});
}
