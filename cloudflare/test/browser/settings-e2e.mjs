// Manual: needs Playwright with Chromium. No network: every endpoint below is intercepted.
import {chromium} from 'playwright';
import {webSettingsPage} from '../../src/web-settings.mjs';
const log=[];let schedule={life_schedule:'unpredictable',explicit:false,revision:null};
const browser=await chromium.launch();const ctx=await browser.newContext();const page=await ctx.newPage();
const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(String(e)));
await ctx.route('https://whooplens.tech/settings/**',async route=>{
  const res=await webSettingsPage(new Request(route.request().url()),{LIFE_SCHEDULE_ENABLED:'true'});
  await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:await res.text()});});
await ctx.route('https://auth.whooplens.tech/authorize**',async route=>{
  const u=new URL(route.request().url());log.push(['authorize',Object.fromEntries(u.searchParams)]);
  await route.fulfill({status:200,headers:{'content-type':'text/html'},body:`<meta http-equiv=refresh content="0;url=https://whooplens.tech/settings/?code=CODE123&state=${u.searchParams.get('state')}">`});});
await ctx.route('https://auth.whooplens.tech/oauth/token',async route=>{
  const r=route.request();const cors={'access-control-allow-origin':'https://whooplens.tech','access-control-allow-headers':'content-type','access-control-allow-methods':'POST'};
  if(r.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
  const body=Object.fromEntries(new URLSearchParams(r.postData()));log.push(['token',body]);
  if(body.token)return route.fulfill({status:200,headers:cors,body:''});
  await route.fulfill({status:200,headers:{...cors,'content-type':'application/json'},body:JSON.stringify({access_token:'AT-e2e',refresh_token:'RT-e2e',token_type:'bearer',expires_in:3600})});});
await ctx.route('https://whooplens.tech/v1/preferences/life-schedule',async route=>{
  const r=route.request();log.push(['api',r.method(),r.headers()['authorization'],r.headers()['origin']??null,r.postData()??null]);
  if(r.method()==='PUT'){schedule={...JSON.parse(r.postData()),explicit:true,revision:'r1'};delete schedule.confirmation;}
  await route.fulfill({status:200,headers:{'content-type':'application/json'},body:JSON.stringify(schedule)});});
await page.goto('https://whooplens.tech/settings/');
await page.getByRole('button',{name:'Sign in'}).click();
try{await page.getByText('Current Life Schedule').waitFor({timeout:8000});}catch(e){console.log('FAILED url',page.url(),'msg',await page.locator('#message').textContent().catch(()=>null));console.log(JSON.stringify(log));console.log('errors',JSON.stringify(errors));await browser.close();process.exit(1);}
console.log('url after callback:',page.url());
console.log('current:',await page.locator('#current').textContent());
await page.getByLabel(/Flexible/).check();
await page.getByRole('button',{name:'Save'}).click();
await page.getByText(/Saved\./).waitFor();
console.log('message:',await page.locator('#message').textContent());
const storage=await page.evaluate(()=>({session:Object.keys(sessionStorage),local:Object.keys(localStorage),cookies:document.cookie}));
console.log('storage after sign-in:',JSON.stringify(storage));
await page.getByRole('button',{name:'Sign out'}).click();
await page.getByText('Signed out.').waitFor();
await page.screenshot({path:'settings-e2e.png',fullPage:true});
for(const l of log)console.log(JSON.stringify(l));
console.log('page errors:',JSON.stringify(errors));
await browser.close();
