// Drives a real headless Chrome through the WHOOP browser-binding flow:
//   GET /api/whoop/start (confirmation page) -> click "Continue to WHOOP" (form POST)
//   -> "Opening WHOOP" page (Refresh) -> WHOOP authorize -> WHOOP sign-in host
//   -> /api/whoop/callback -> result page.
// whooplens.tech, api.prod.whoop.com and id.whoop.com resolve to a local HTTPS server (a throwaway
// self-signed certificate made with openssl for this run), so Chrome applies its real
// Origin, Referrer-Policy, Sec-Fetch and cookie rules. Nothing reaches the network.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';

const HOSTS=['whooplens.tech','api.prod.whoop.com','id.whoop.com'];

export function browserProbeAvailable(chromePath){
  try{execFileSync('openssl',['version'],{stdio:'ignore'});}catch{return false;}
  return !!chromePath;
}

async function tlsServer(dir,handle,requests){
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=whooplens.tech',
    '-addext','subjectAltName='+HOSTS.map(h=>'DNS:'+h).join(','),
    '-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
  const server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},async(req,res)=>{
    const seen={method:req.method,url:'https://'+req.headers.host+req.url,origin:req.headers.origin??null,
      secFetchSite:req.headers['sec-fetch-site']??null,cookie:req.headers.cookie??null,referer:req.headers.referer??null};
    try{
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=Buffer.concat(chunks).toString('utf8');
      if(req.method==='POST')seen.body=body;
      if(req.url==='/favicon.ico'){res.writeHead(404);res.end();return;}
      requests.push(seen);
      const headers=new Headers();
      for(const [k,v] of Object.entries(req.headers))headers.set(k,Array.isArray(v)?v.join(', '):v);
      const response=await handle(new Request(seen.url,{method:req.method,headers,body:req.method==='POST'?body:undefined}),seen);
      seen.status=response.status;
      const out={};
      response.headers.forEach((v,k)=>{out[k]=k==='set-cookie'?response.headers.getSetCookie():v;});
      res.writeHead(response.status,out);
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){seen.error=String(error?.message||error);res.writeHead(500);res.end('probe error');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return server;
}

// `done` is a page expression that is true once the flow has reached its final page.
export async function probeWhoopStart(chromePath,{startUrl,handle,done,timeoutMs=15000}){
  const dir=mkdtempSync(join(tmpdir(),'whoop-start-chrome-'));
  const requests=[];
  const server=await tlsServer(dir,handle,requests);
  const port=server.address().port;
  const rules=HOSTS.map(h=>`MAP ${h}:443 127.0.0.1:${port}`).join(', ')+', MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
  const chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=0',
    '--user-data-dir='+join(dir,'profile'),'--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules='+rules,'about:blank'],{stdio:['ignore','ignore','pipe']});
  // Keep the tail of Chrome's stderr and its exit status so a failed start says why.
  let stderr='',exit=null;
  chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  chrome.once('exit',(code,signal)=>{exit={code,signal};});
  let ws;
  try{
    let devtools;
    // Cold CI runners can take well over 10 s to start a first headless Chrome.
    for(let i=0;i<300&&!devtools&&!exit;i++){
      try{const line=readFileSync(join(dir,'profile','DevToolsActivePort'),'utf8').split('\n')[0];if(/^\d+$/.test(line))devtools=line;}
      catch(error){if(!['ENOENT','EBUSY','EACCES'].includes(error.code))throw error;}
      if(!devtools)await pause(100);
    }
    if(!devtools)throw Error('Test Chrome did not start ('+(exit?'exited '+JSON.stringify(exit):'no DevTools port after 30 s')+'): '+stderr.trim().slice(-600));
    let target;
    for(let i=0;i<50&&!target;i++){
      target=(await (await fetch('http://127.0.0.1:'+devtools+'/json/list')).json()).find(t=>t.type==='page');
      if(!target)await pause(100);
    }
    if(!target)throw Error('Test Chrome opened no page');
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    const pending=new Map();let seq=0;
    ws.onmessage=event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=pending.get(m.id);pending.delete(m.id);
      m.error?p?.reject(Error(p.method+': '+m.error.message)):p?.resolve(m.result);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,method});ws.send(JSON.stringify({id,method,params}));});
    await send('Page.enable');await send('Runtime.enable');
    const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
    const waitFor=async(expression,label)=>{
      const end=Date.now()+timeoutMs;
      while(Date.now()<end){try{if(await evaluate(expression))return;}catch{/* navigating */}await pause(50);}
      throw Error('Timed out waiting for '+label+'; requests: '+JSON.stringify(requests));
    };
    await send('Page.navigate',{url:startUrl});
    await waitFor('document.querySelector("form button[type=submit]")!==null','confirmation page');
    const confirmation=await evaluate('({title:document.querySelector("h1")?.textContent,text:document.body.innerText,action:document.forms[0]?.getAttribute("action"),method:document.forms[0]?.method,state:document.forms[0]?.state?.value??null})');
    await evaluate('document.querySelector("form button[type=submit]").click()');
    await waitFor(done,'final page');
    const result=await evaluate('({url:location.href,title:document.querySelector("h1")?.textContent??"",text:document.body.innerText})');
    return {confirmation,result,requests};
  }finally{
    ws?.close();
    const exited=exit?Promise.resolve():new Promise(r=>chrome.once('exit',r));
    chrome.kill();
    await Promise.race([exited,pause(3000)]);
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
    try{rmSync(dir,{recursive:true,force:true});}catch{/* best effort */}
  }
}
