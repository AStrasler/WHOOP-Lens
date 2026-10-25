import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {noStoreHeaders,consentPage} from '../../oauth/consent.mjs';
export async function probeConsentRedirects(chromePath) {
const servers=[];
async function listen(handler){const s=createServer(handler);servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+s.address().port;}
let auth,access,android,chatgpt,policy,destination,hits=0,blocked=false,paths=[],failures=[],consumed=false;
android=await listen((q,s)=>{if(q.url==='/android/oauth/callback'){hits++;s.end('CALLBACK_REACHED');}else{s.writeHead(404);s.end();}});
chatgpt=await listen((q,s)=>{if(q.url==='/connector_platform_oauth_redirect'){hits++;s.end('CALLBACK_REACHED');}else{s.writeHead(404);s.end();}});
access=await listen((q,s)=>{s.writeHead(302,{location:auth+'/upstream-finish'});s.end();});
auth=await listen((q,s)=>{
 paths.push(q.method+' '+q.url);
 if(q.url==='/authorize'&&q.method==='GET'){
  consumed=false;
  s.writeHead(200,{'content-type':'text/html','content-security-policy':policy,'referrer-policy':'same-origin'});
  s.end(consentPage({clientName:'Synthetic Android',redirectHost:'whooplens.tech',scope:['mcp:read','offline_access']},'synthetic-handle-abcdefghijklmnop'));
 }else if(q.method==='POST'&&consumed){s.writeHead(400);s.end('Authorization unavailable');}
 else{if(q.method==='POST')consumed=true;const location=q.method==='POST'?auth+'/upstream-start':q.url==='/upstream-start'?access+'/login':destination;s.writeHead(302,{location});s.end();}
});
const profile=mkdtempSync(join(tmpdir(),'whoop-oauth-chrome-'));
const chrome=spawn(chromePath,['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','about:blank'],{windowsHide:true,stdio:'ignore'});
let ws;
try{
 const portfile=join(profile,'DevToolsActivePort');let port;
 // On Windows Chrome can hold its newly-created port file open briefly.
 for(let i=0;i<100;i++){
  try{const candidate=readFileSync(portfile,'utf8').split('\n')[0];if(/^\d+$/.test(candidate)){port=candidate;break;}}
  catch(error){if(!['ENOENT','EBUSY','EACCES'].includes(error.code))throw error;}
  await pause(100);
 }
 if(!port)throw Error('Test Chrome did not start');
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const pending=new Map();let seq=0;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error('CDP command failed')):p?.resolve(m.result);}if(m.method==='Log.entryAdded'&&m.params.entry.text.includes('form-action'))blocked=true; if(m.method==='Network.loadingFailed'){failures.push({reason:m.params.blockedReason,error:m.params.errorText});if(m.params.blockedReason==='csp')blocked=true;}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
 const fixed=noStoreHeaders('text/html; charset=utf-8')['content-security-policy'];
 const original=fixed.replace(' https://whooplens.tech/android/oauth/callback','');
 const localize=p=>p.replaceAll('https://auth.whooplens.tech',auth).replaceAll('https://whoop-lens.cloudflareaccess.com',access).replaceAll('https://chatgpt.com',chatgpt).replaceAll('https://whooplens.tech',android);
 const results=[];
 for(const [name,p,target,expect] of [['before Android',original,android+'/android/oauth/callback',false],['after Android',fixed,android+'/android/oauth/callback',true],['before ChatGPT',original,chatgpt+'/connector_platform_oauth_redirect',true],['after ChatGPT',fixed,chatgpt+'/connector_platform_oauth_redirect',true],['untrusted redirect',fixed,'http://localhost:'+new URL(android).port+'/untrusted',false]]){
  hits=0;blocked=false;paths=[];failures=[];policy=localize(p);destination=target;
  await send('Page.navigate',{url:auth+'/authorize'});
  for(let i=0;i<50;i++){const r=await send('Runtime.evaluate',{expression:'document.querySelector("button.primary") !== null',returnByValue:true});if(r.result.value)break;await pause(50);}
  await send('Runtime.evaluate',{expression:'document.querySelector("button.primary").click()'});
  for(let i=0;i<100&&!hits&&!blocked;i++)await pause(50);
  const passed=expect?hits===1&&!blocked:hits===0&&blocked;
  let resubmissionRejected;
  if(name==='before Android'&&blocked){
   await send('Runtime.evaluate',{expression:'document.querySelector("button.primary").click()'});
   for(let i=0;i<50;i++){const r=await send('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true});if(r.result.value==='Authorization unavailable'){resubmissionRejected=true;break;}await pause(50);}
  }
  const page=await send('Runtime.evaluate',{expression:'({path:location.pathname,text:document.body.innerText.slice(0,80),forms:document.forms.length})',returnByValue:true});
  results.push({name,callbackReached:hits===1,cspBlocked:blocked,passed,resubmissionRejected,paths,failures,page:page.result.value});
 }
 return results;
}finally{ws?.close();chrome.kill();for(const s of servers)s.closeAllConnections();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));}

}
