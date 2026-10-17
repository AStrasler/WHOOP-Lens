// Shared presentation for the public request form and its result/error pages.
export const seatRequestShell = body => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Request a WHOOP Lens seat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@500&amp;display=swap" rel="stylesheet">
<style>
:root{--bg:#0b1418;--bg-2:#0f1c21;--card:#132228;--card-edge:#1e333a;--field:#0e1a1e;--teal:#4fd8cf;--teal-dim:#2a8f89;--teal-glow:rgba(79,216,207,.28);--text:#eef6f5;--muted:#8aa3a6;--faint:#8aa3a6}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{font-family:"Inter",system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(900px 500px at 50% -10%,rgba(79,216,207,.10),transparent 60%),linear-gradient(180deg,var(--bg-2),var(--bg));background-attachment:fixed;color:var(--text);display:grid;place-items:center;padding:32px 16px;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:460px;background:linear-gradient(180deg,var(--card),#101d22);border:1px solid var(--card-edge);border-radius:24px;padding:36px 28px 28px;box-shadow:0 30px 80px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.03)}
.mark{width:84px;height:84px;margin:0 auto 22px;border-radius:22px;background:linear-gradient(160deg,#1a2a30,#0c171b);border:1px solid #22383f;display:grid;place-items:center;box-shadow:0 0 0 6px rgba(79,216,207,.04),0 10px 30px rgba(0,0,0,.4)}
.mark svg{width:62px;height:62px;filter:drop-shadow(0 0 8px var(--teal-glow))}
.pulse-line{stroke-dasharray:120;stroke-dashoffset:120;animation:trace 2.4s ease-in-out infinite}
@keyframes trace{0%{stroke-dashoffset:120}45%,70%{stroke-dashoffset:0}100%{stroke-dashoffset:-120}}
@media(prefers-reduced-motion:reduce){.pulse-line{animation:none;stroke-dashoffset:0}}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;text-align:center;line-height:1.25}
h1 span{color:var(--teal)}
.lede{margin-top:8px;text-align:center;color:var(--muted);font-size:14.5px;line-height:1.55}
.seats{margin:22px 0 6px;border:1px solid var(--card-edge);border-radius:14px;padding:14px}
.seat-row{display:flex;gap:6px;justify-content:center;margin-bottom:12px}
.seat{width:22px;height:22px;border-radius:7px;border:1.5px solid var(--teal-dim);background:rgba(79,216,207,.05)}
.seat.reserved{background:var(--teal-dim);border-color:var(--teal)}
.seat.owner{background:var(--teal);border-color:var(--teal);box-shadow:0 0 10px var(--teal-glow)}
.seat-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;font-size:12.5px;color:var(--muted)}
.seat-legend b{color:var(--text);font-weight:600}
.seat-legend .sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px;border:1.5px solid var(--teal-dim)}
.seat-legend .sw.reserved{background:var(--teal-dim);border-color:var(--teal)}
.seat-legend .sw.owner{background:var(--teal);border-color:var(--teal)}
.notice{margin-top:12px;text-align:center;font-size:12.5px;color:var(--faint);line-height:1.5}
form{margin-top:22px}
.field{display:block;margin-bottom:16px}
.field>span{display:block;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
.field>span em{font-style:normal;text-transform:none;letter-spacing:0;font-weight:500;color:var(--faint)}
input:not([type="checkbox"]),textarea{font:inherit;font-size:16px;width:100%;padding:12px 14px;color:var(--text);background:var(--field);border:1px solid var(--card-edge);border-radius:12px;transition:border-color .2s ease,box-shadow .2s ease}
textarea{resize:vertical;min-height:104px;line-height:1.5}
input:not([type="checkbox"]):hover,textarea:hover{border-color:#2c464e}
input:not([type="checkbox"]):focus,textarea:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(79,216,207,.15)}
.trap{display:none}
.consent{display:flex;align-items:flex-start;gap:12px;padding:13px 14px;border-radius:12px;background:rgba(79,216,207,.06);border:1px solid rgba(79,216,207,.22);font-size:13.5px;line-height:1.5;color:var(--text);cursor:pointer}
.consent input{appearance:none;width:20px;height:20px;flex:none;margin-top:1px;border-radius:6px;border:1.5px solid var(--teal-dim);display:grid;place-items:center;cursor:pointer}
.consent input:checked{background:var(--teal);border-color:var(--teal)}
.consent input:checked::after{content:"";width:10px;height:6px;margin-top:-2px;border-left:2px solid #062023;border-bottom:2px solid #062023;transform:rotate(-45deg)}
.consent input:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
.note{margin-top:16px;display:flex;gap:10px;align-items:flex-start;color:var(--muted);font-size:12.5px;line-height:1.55}
.note svg{flex:none;margin-top:2px}
.note>span{min-width:0;overflow-wrap:anywhere}
.note strong{color:var(--text);font-weight:600}
.note code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11.5px;color:var(--teal)}
.cf-turnstile{margin-top:18px;display:flex;justify-content:center}
button{margin-top:18px;width:100%;font:inherit;font-weight:600;font-size:15px;padding:14px 16px;border-radius:12px;cursor:pointer;border:0;color:#052023;background:linear-gradient(180deg,#6ae6dd,var(--teal));box-shadow:0 8px 24px var(--teal-glow),inset 0 1px 0 rgba(255,255,255,.35);transition:transform .08s ease,box-shadow .2s ease}
button:hover{box-shadow:0 10px 32px rgba(79,216,207,.42),inset 0 1px 0 rgba(255,255,255,.35)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
a{color:var(--teal)}
footer{margin-top:20px;padding-top:16px;border-top:1px solid var(--card-edge);text-align:center;color:var(--faint);font-size:12px;line-height:1.5}
.result p{margin-top:18px;line-height:1.6;overflow-wrap:anywhere}
@media(max-width:380px){body{padding:16px 8px}main{padding:28px 14px 22px}.seat-row{gap:4px}}
</style>
</head>
<body><main>
<div class="mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="27" stroke="#4fd8cf" stroke-width="4"/><path class="pulse-line" d="M8 33h13l3-5 4 12 5-20 4 15 3-2h12" stroke="#eef6f5" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="56" cy="33" r="2.6" fill="#4fd8cf"/></svg></div>
<h1>Request a <span>WHOOP Lens</span> seat</h1>
${body}
<footer>Only invited, active WHOOP Lens members can finish connecting.</footer>
</main></body></html>`;

// siteKey must be HTML-escaped by the caller, never a secret key.
export const seatRequestForm = siteKey => `
<p class="lede">WHOOP Lens is private. Only the owner can approve access.</p>
<div class="seats">
<div class="seat-row" aria-hidden="true"><i class="seat owner"></i>${'<i class="seat reserved"></i>'.repeat(2)}${'<i class="seat"></i>'.repeat(7)}</div>
<div class="seat-legend"><span><i class="sw owner"></i><b>1</b> owner/developer</span><span><i class="sw reserved"></i><b>2</b> reserved</span><span><i class="sw"></i><b>7</b> open</span></div>
</div>
<p class="notice">A request does not reserve a seat or create an account.</p>
<form method="post" action="/request-seat">
<label class="field"><span>Name</span><input name="name" required maxlength="100" autocomplete="name"></label>
<label class="field"><span>Email you want to use</span><input name="email" type="email" required maxlength="254" autocomplete="email"></label>
<label class="field"><span>Message <em>(optional)</em></span><textarea name="message" maxlength="1000" rows="4"></textarea></label>
<label class="trap" aria-hidden="true">Leave empty<input name="website" tabindex="-1" autocomplete="off"></label>
<label class="consent"><input type="checkbox" name="consent" value="contact-me" required><span>I agree to email these details to the WHOOP Lens owner and be contacted about my request.</span></label>
<div class="note"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2" stroke="#4fd8cf" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" stroke="#4fd8cf" stroke-width="2"/></svg><span><strong>Do not include health information, passwords or tokens.</strong> Your details are emailed to <code>whoop-lens@outlook.com</code>. Hashed request metadata is used for duplicate and abuse protection; form contents are not stored in the request database. The owner's mailbox retains the email under its retention settings. Cloudflare Turnstile checks this form for abuse.</span></div>
<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="seat-request" data-theme="dark" data-size="compact"></div>
<button type="submit">Request a seat</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
