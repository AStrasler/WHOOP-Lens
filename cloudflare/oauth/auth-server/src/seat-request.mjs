const ORIGIN='https://auth.whooplens.tech';
export const SEAT_REQUEST_PATH='/request-seat';
export const SEAT_REQUEST_TO='whoop-lens@outlook.com';
const headers={'cache-control':'no-store','content-type':'text/html; charset=utf-8','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(body,status=200)=>new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request a WHOOP Lens seat</title><style>body{font:18px system-ui;background:#111827;color:#f3f4f6;max-width:38rem;margin:3rem auto;padding:1rem}label{display:block;margin:1rem 0}input,textarea,button{font:inherit;box-sizing:border-box;padding:.7rem;width:100%;border-radius:.4rem}button{background:#93c5fd;color:#111827;border:0;cursor:pointer}a{color:#93c5fd}.trap{display:none}small{display:block;margin:1rem 0}</style><main><h1>Request a WHOOP Lens seat</h1>${body}</main></html>`,{status,headers});
const message=(s,status)=>page(`<p>${escape(s)}</p><p><a href="${SEAT_REQUEST_PATH}">Return to the request form</a></p>`,status);
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
async function formBody(request){
 if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))throw Error('format');
 const reader=request.body?.getReader();if(!reader)throw Error('body');let size=0,parts=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw Error('size');}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let i=0;for(const p of parts){bytes.set(p,i);i+=p.length;}
 const data=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if([...data.keys()].some(k=>!['name','email','message','website','consent','cf-turnstile-response'].includes(k))||[...new Set(data.keys())].some(k=>data.getAll(k).length!==1))throw Error('fields');
 const name=(data.get('name')||'').trim(),email=(data.get('email')||'').trim().toLowerCase(),note=(data.get('message')||'').trim(),token=data.get('cf-turnstile-response')||'';
 if(!name||name.length>100||/[\x00-\x1f\x7f]/.test(name)||email.length>254||! /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)||note.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)||token.length>2048||!token||data.get('website')||data.get('consent')!=='contact-me')throw Error('invalid');
 return {name,email,note,token};
}
export function createSeatRequestHandler({sendMail,fetcher=fetch,now=Date.now}={}){
 return async function handle(request,env){
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||url.pathname!==SEAT_REQUEST_PATH)return message('Not found.',404);
  if(env.SEAT_REQUEST_ENABLED!=='true'||!env.DB||!env.SEAT_REQUEST_TURNSTILE_SITE_KEY||!env.SEAT_REQUEST_TURNSTILE_SECRET||typeof sendMail!=='function')return message('Seat requests are not available yet. Contact whoop-lens@outlook.com directly.',503);
  if(request.method==='GET')return page(`<p>WHOOP Lens is private. Only the owner can approve access. There is one reserved owner/developer seat and up to nine approved member seats.</p><p>A request does not reserve a seat or create an account.</p><form method="post" action="${SEAT_REQUEST_PATH}"><label>Name<input name="name" required maxlength="100" autocomplete="name"></label><label>Email you want to use<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label>Message (optional)<textarea name="message" maxlength="1000" rows="4"></textarea></label><label class="trap" aria-hidden="true">Leave empty<input name="website" tabindex="-1" autocomplete="off"></label><label><input type="checkbox" name="consent" value="contact-me" required style="width:auto"> I agree to email these details to the WHOOP Lens owner and be contacted about my request.</label><small>Do not include health information, passwords or tokens. Your details are emailed to whoop-lens@outlook.com. Hashed request metadata is used for duplicate and abuse protection; form contents are not stored in the request database. The owner's mailbox retains the email under its retention settings. Cloudflare Turnstile checks this form for abuse.</small><div class="cf-turnstile" data-sitekey="${escape(env.SEAT_REQUEST_TURNSTILE_SITE_KEY)}" data-action="seat-request"></div><button type="submit">Request a seat</button></form><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
  if(request.method!=='POST')return message('Method not allowed.',405);
  if(request.headers.get('origin')!==ORIGIN)return message('Please submit the form from this site.',403);
  let data;try{data=await formBody(request);}catch{return message('Check your name, email, message and verification, then try again.',400);}
  const timestamp=now(),ip=request.headers.get('cf-connecting-ip');
  if(!ip)return message('Request verification unavailable.',503);
  try{
   const db=env.DB;
   await db.batch([db.prepare('DELETE FROM seat_request_limits WHERE expires_at<?1').bind(timestamp),db.prepare('DELETE FROM seat_request_delivery WHERE expires_at<?1').bind(timestamp)]);
   const bucket=await hash(env.SEAT_REQUEST_TURNSTILE_SECRET+'|'+ip+'|'+Math.floor(timestamp/3600000));
   const limit=await db.prepare('INSERT INTO seat_request_limits(bucket,count,expires_at) VALUES(?1,1,?2) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<5 RETURNING count').bind(bucket,timestamp+3600000).first();
   if(!limit)return message('Too many requests. Please try again in an hour.',429);
   const check=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:env.SEAT_REQUEST_TURNSTILE_SECRET,response:data.token,remoteip:ip}),signal:AbortSignal.timeout(8000)});
   if(!check.ok)throw Error('verify unavailable');const result=await check.json();
   if(result.success!==true||result.hostname!=='auth.whooplens.tech'||result.action!=='seat-request')return message('Verification failed. Reload the form and try again.',400);
   const emailHash=await hash(env.SEAT_REQUEST_TURNSTILE_SECRET+'|email|'+data.email),claim=crypto.randomUUID();
   const taken=await db.prepare("INSERT INTO seat_request_delivery(email_hash,claim,status,expires_at) VALUES(?1,?2,'pending',?3) ON CONFLICT(email_hash) DO UPDATE SET claim=excluded.claim,status='pending',expires_at=excluded.expires_at WHERE status='failed' OR expires_at<?4 RETURNING claim").bind(emailHash,claim,timestamp+300000,timestamp).first();
   if(!taken){const existing=await db.prepare('SELECT status FROM seat_request_delivery WHERE email_hash=?1').bind(emailHash).first();return message(existing?.status==='sent'?'A request for this email was already received recently. Access requires the owner’s approval.':'A request for this email is being processed. Wait a few minutes before retrying.',existing?.status==='sent'?200:202);}
   try{await sendMail({name:data.name,email:data.email,message:data.note},env);}catch{
    await db.prepare("UPDATE seat_request_delivery SET status='failed' WHERE email_hash=?1 AND claim=?2").bind(emailHash,claim).run();
    return message('Email delivery could not be confirmed. Please try again later; access has not been granted.',503);
   }
   await db.prepare("UPDATE seat_request_delivery SET status='sent',expires_at=?3 WHERE email_hash=?1 AND claim=?2").bind(emailHash,claim,timestamp+86400000).run();
   return message('Request received. Access requires the owner’s approval. Watch your email for a reply.',200);
  }catch{return message('Request processing is temporarily unavailable. Please try again later.',503);}
 };
}
