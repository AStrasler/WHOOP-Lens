#!/usr/bin/env node
// Safe WHOOP Lens rate-limit adjustment. Node 20+; no dependencies.
const args = process.argv.slice(2);
const get = key => { const i=args.indexOf(key); return i<0?undefined:args[i+1]; };
const apply=args.includes('--apply');
const updates={};
for(const [arg,name] of [['--member','WHOOP_MEMBER_LIMIT_PER_MINUTE'],['--developer','WHOOP_DEVELOPER_LIMIT_PER_MINUTE']]){
 const value=get(arg);
 if(value!==undefined){if(!/^[1-9]\\d*$/.test(value)||Number(value)>100)throw Error(arg+' must be an integer from 1 to 100');updates[name]=value;}
}
if(!Object.keys(updates).length)throw Error('Specify --member and/or --developer');
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token||!account)throw Error('Missing Cloudflare API credentials');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(account)+'/workers/scripts/whoop-lens';
async function api(path,options={}){
 const res=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
 const json=await res.json();
 if(!res.ok||json.success===false)throw Error('Cloudflare request failed: '+res.status+' '+JSON.stringify(json.errors||[]));
 return json.result;
}
const current=await api('/settings');
const deployments=await api('/deployments');
const deployed=deployments.deployments?.[0]?.versions?.[0]?.version_id;
if(!deployed||deployments.deployments[0].versions.length!==1||deployments.deployments[0].versions[0].percentage!==100)throw Error('Unexpected deployment state');
const original=current.bindings;
if(!Array.isArray(original)||new Set(original.map(b=>b.name)).size!==original.length)throw Error('Invalid live binding list');
for(const name of ['DB','AUTH_SERVER','AI','MCP_ENABLED','WHOOP_READS_ENABLED'])if(!original.some(b=>b.name===name))throw Error('Critical binding missing: '+name);
const expected=original.map(b=>updates[b.name]===undefined?b:{...b,text:updates[b.name]});
for(const [name,text] of Object.entries(updates))if(!expected.some(b=>b.name===name))expected.push({name,type:'plain_text',text});
console.log(JSON.stringify({apply,deployed,bindingCountBefore:original.length,bindingCountAfter:expected.length,changes:updates},null,2));
if(!apply)process.exit(0);
const check=await api('/deployments');
if(check.deployments?.[0]?.versions?.[0]?.version_id!==deployed)throw Error('Production changed during preparation; aborting');
const form=new FormData();
form.append('settings',new Blob([JSON.stringify({bindings:expected,annotations:{'workers/message':'Safe WHOOP rate-limit update; preserve all existing bindings'}})],{type:'application/json'}));
await api('/settings',{method:'PATCH',body:form});
const actual=(await api('/settings')).bindings;
const normalize=a=>new Map(a.map(b=>[b.name,JSON.stringify(Object.fromEntries(Object.entries(b).sort(([x],[y])=>x.localeCompare(y))))]));
const want=normalize(expected),got=normalize(actual);
if(want.size!==got.size||[...want].some(([k,v])=>got.get(k)!==v))throw Error('POST-UPDATE VERIFICATION FAILED: inspect production immediately');
console.log('Verified '+actual.length+' bindings, all preserved.');
