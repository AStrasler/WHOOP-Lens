import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createSeatRequestHandler} from '../oauth/auth-server/src/seat-request.mjs';
import {SEAT_ALLOCATION,seatCounts} from '../oauth/auth-server/src/seat-request-page.mjs';
const origin='https://auth.whooplens.tech';
function setup(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0014_seat_requests.sql',import.meta.url),'utf8'));const sent=[];let clock=100000000;
 const env={DB:d1Database(sql),SEAT_REQUEST_ENABLED:'true',SEAT_REQUEST_TURNSTILE_SITE_KEY:'synthetic-site',SEAT_REQUEST_TURNSTILE_SECRET:'synthetic-secret'};
 const dependencies={now:()=>clock,fetcher:async()=>Response.json({success:true,hostname:'auth.whooplens.tech',action:'seat-request'}),sendMail:async d=>sent.push(d)};
 return {sql,env,sent,dependencies,advance:ms=>clock+=ms,call:(request)=>createSeatRequestHandler(dependencies)(request,env)};}
const fields={name:'Synthetic Applicant',email:'synthetic@example.test',message:'Please contact me.',consent:'contact-me','cf-turnstile-response':'synthetic-token'};
const post=(data=fields,headers={})=>new Request(origin+'/request-seat',{method:'POST',headers:{origin,'cf-connecting-ip':'192.0.2.1',...headers},body:new URLSearchParams(data)});
test('public form is gated, escaped and carries no identity or authorization state',async()=>{const s=setup();try{
 s.env.SEAT_REQUEST_ENABLED='false';assert.equal((await s.call(new Request(origin+'/request-seat'))).status,503);s.env.SEAT_REQUEST_ENABLED='true';s.env.SEAT_REQUEST_TURNSTILE_SITE_KEY='"><script>bad</script>';
 const r=await s.call(new Request(origin+'/request-seat?state=private'));const text=await r.text();assert.equal(r.status,200);assert.ok(!text.includes('<script>bad'));assert.ok(!text.includes('state=private'));assert.match(text,/does not reserve a seat/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await s.call(new Request(origin+'/authorize'))).status,404);
}finally{s.sql.close();}});
test('valid applicant sends once and stores only hashes and delivery metadata',async()=>{const s=setup();try{
 assert.equal((await s.call(post())).status,200);assert.equal(s.sent.length,1);assert.equal(s.sent[0].email,fields.email);
 const rows=s.sql.prepare('SELECT * FROM seat_request_delivery').all();assert.doesNotMatch(JSON.stringify(rows),/Synthetic|example.test|contact me/);
 assert.equal((await s.call(post())).status,200);assert.equal(s.sent.length,1);
 s.advance(86400001);assert.equal((await s.call(post())).status,200);assert.equal(s.sent.length,2);
 assert.deepEqual(s.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),['seat_request_delivery','seat_request_limits']);
}finally{s.sql.close();}});
test('cross-origin, malformed, header-injection, extra owners, honeypot and missing consent fail before email',async()=>{const s=setup();try{
 assert.equal((await s.call(post(fields,{origin:'https://other.test'}))).status,403);
 for(const data of [{...fields,email:'a@example.test\r\nBcc: other@example.test'},{...fields,name:'x\nInjected'},{...fields,user_id:'owner'},{...fields,website:'bot'},{...fields,consent:''},{...fields,message:'x'.repeat(1001)}])assert.equal((await s.call(post(data))).status,400);
 const duplicate=new URLSearchParams(fields);duplicate.append('email','other@example.test');assert.equal((await s.call(post(duplicate))).status,400);assert.equal(s.sent.length,0);
}finally{s.sql.close();}});
test('failed, wrong-host and wrong-action challenge responses do not send',async()=>{for(const result of [{success:false},{success:true,hostname:'evil.test',action:'seat-request'},{success:true,hostname:'auth.whooplens.tech',action:'login'}]){const s=setup();try{s.dependencies.fetcher=async()=>Response.json(result);assert.equal((await s.call(post())).status,400);assert.equal(s.sent.length,0);}finally{s.sql.close();}}});
test('verification outage and oversized bodies fail closed',async()=>{const s=setup();try{s.dependencies.fetcher=async()=>{throw Error('offline')};assert.equal((await s.call(post())).status,503);assert.equal((await s.call(post({...fields,message:'x'.repeat(9000)}))).status,400);assert.equal(s.sent.length,0);}finally{s.sql.close();}});
test('mail failure is retryable and never reports received',async()=>{const s=setup();try{s.dependencies.sendMail=async()=>{throw Error('offline')};const r=await s.call(post());assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/Request received/);s.dependencies.sendMail=async d=>s.sent.push(d);assert.equal((await s.call(post())).status,200);assert.equal(s.sent.length,1);}finally{s.sql.close();}});
test('pending concurrent requests do not send a second email',async()=>{const s=setup();try{let release,entered;const started=new Promise(r=>entered=r);s.dependencies.sendMail=async d=>{s.sent.push(d);entered();await new Promise(r=>release=r)};const first=s.call(post());await started;assert.equal((await s.call(post())).status,202);assert.equal(s.sent.length,1);release();assert.equal((await first).status,200);}finally{s.sql.close();}});
test('per-IP hourly limit and independent applicants',async()=>{const s=setup();try{for(let i=0;i<5;i++)assert.equal((await s.call(post({...fields,email:`person${i}@example.test`}))).status,200);assert.equal((await s.call(post())).status,429);assert.equal((await s.call(post(fields,{'cf-connecting-ip':'192.0.2.2'}))).status,200);s.advance(3600001);assert.equal((await s.call(post({...fields,email:'later@example.test'}))).status,200);}finally{s.sql.close();}});
test('branded form retains submission contract and narrowly scoped font policy',async()=>{const s=setup();try{
 const response=await s.call(new Request(origin+'/request-seat'));const html=await response.text();
 assert.match(html,/<form method="post" action="\/request-seat">/);
 for(const name of ['name','email','message','website','consent'])assert.match(html,new RegExp(`name="${name}"`));
 assert.match(html,/name="consent" value="contact-me" required/);assert.doesNotMatch(html,/name="consent"[^>]*checked/);
 assert.match(html,/data-sitekey="synthetic-site" data-action="seat-request" data-theme="dark" data-size="compact"/);
 assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/fonts.googleapis.com/);
 const csp=response.headers.get('content-security-policy');
 assert.match(csp,/style-src 'unsafe-inline' https:\/\/fonts.googleapis.com;/);assert.match(csp,/font-src https:\/\/fonts.gstatic.com;/);
 assert.match(csp,/script-src https:\/\/challenges.cloudflare.com;/);assert.match(csp,/form-action 'self';/);
 assert.doesNotMatch(csp,/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(s.sent.length,0);
 const failed=await s.call(post({...fields,consent:''}));const errorHtml=await failed.text();assert.equal(failed.status,400);
 assert.match(errorHtml,/class="mark"/);assert.match(errorHtml,/class="result"/);assert.match(errorHtml,/Return to the request form/);assert.doesNotMatch(errorHtml,/<form|synthetic@example/);
 const success=await s.call(post());assert.match(await success.text(),/Request received/);assert.equal(s.sent.length,1);
}finally{s.sql.close();}});
test('seat illustration shows the three-seat allocation as counts only',async()=>{const s=setup();try{
 const html=await (await s.call(new Request(origin+'/request-seat'))).text();
 assert.deepEqual(seatCounts(),{max:3,owner:1,members:1,reserved:1,open:0});
 assert.equal(SEAT_ALLOCATION.max,3);
 const row=html.match(/<div class="seat-row"[^>]*>(.*?)<\/div>/)[1];
 assert.equal((row.match(/<i class="seat[^"]*"><\/i>/g)||[]).length,3);
 assert.equal((row.match(/class="seat owner"/g)||[]).length,1);
 assert.equal((row.match(/class="seat member"/g)||[]).length,1);
 assert.equal((row.match(/class="seat reserved"/g)||[]).length,1);
 assert.equal((row.match(/class="seat"/g)||[]).length,0);
 const legend=html.match(/<div class="seat-legend">(.*?)<\/div>/)[1].replace(/<[^>]+>/g,'');
 assert.equal(legend,'1 owner/developer1 approved member1 reserved, pending owner approval0 open3 max');
 assert.match(html,/3 seats total, including the owner's/);
 assert.doesNotMatch(html,/7 open|2 reserved/);
 // Counts only: no names, relationships or addresses.
 assert.doesNotMatch(html.replace(/whoop-lens@outlook\.com/g,''),/@[a-z0-9.-]+\.[a-z]{2,}|\b(mother|mom|sister|brother|wife|husband|son|daughter|aaron|amy|kimberly)\b/i);
}finally{s.sql.close();}});
test('seat allocation rejects more seats than the maximum and computes open seats',()=>{
 assert.deepEqual(seatCounts({max:3,owner:1,members:2,reserved:0}),{max:3,owner:1,members:2,reserved:0,open:0});
 assert.deepEqual(seatCounts({max:5,owner:1,members:1,reserved:1}).open,2);
 assert.throws(()=>seatCounts({max:3,owner:1,members:2,reserved:1}),/Invalid seat allocation/);
 assert.throws(()=>seatCounts({max:3,owner:1,members:-1,reserved:0}),/Invalid seat allocation/);
});
