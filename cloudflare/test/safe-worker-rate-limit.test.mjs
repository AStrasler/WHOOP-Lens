import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=readFileSync(new URL('../scripts/safe-worker-rate-limit.mjs',import.meta.url),'utf8');
const bindings=[
 {name:'DB',type:'d1',database_id:'db-id'},
 {name:'AUTH_SERVER',type:'service',service:'whoop-lens-auth',environment:'production'},
 {name:'AI',type:'ai'},
 {name:'MCP_ENABLED',type:'plain_text',text:'true'},
 {name:'WHOOP_READS_ENABLED',type:'plain_text',text:'true'},
 {name:'WHOOP_MEMBER_LIMIT_PER_MINUTE',type:'plain_text',text:'25'},
 {name:'WHOOP_CLIENT_SECRET',type:'secret_text'},
 {name:'BK_WHOOP_CLIENT_SECRET',type:'secrets_store_secret',store_id:'store',secret_name:'WHOOP_CLIENT_SECRET'}
];
async function run(args,{initial=bindings,changedDeployment=false}={}){
 let live=structuredClone(initial),writes=0,deployCalls=0;
 const fetch=async(url,options={})=>{
  let result;
  if(url.endsWith('/deployments')){deployCalls++;result={deployments:[{versions:[{version_id:changedDeployment&&deployCalls>1?'changed':'original',percentage:100}]}]};}
  else if(options.method==='PATCH'){
   writes++;
   const form=JSON.parse(await options.body.get('settings').text());
   live=form.bindings;
   result={bindings:live};
  }else result={bindings:live};
  return {ok:true,status:200,json:async()=>({success:true,result})};
 };
 const logs=[];
 const context={process:{argv:['node','script',...args],env:{CLOUDFLARE_API_TOKEN:'test',CLOUDFLARE_ACCOUNT_ID:'test'},exit:()=>{throw new Error('PREVIEW_EXIT');}},fetch,FormData,Blob,console:{log:x=>logs.push(x)},Error,JSON,Set,Map,Object,Number};
 try {await vm.runInNewContext('(async()=>{'+script.replace(/^#![^\n]*\n/,'')+'\n})()',context);}
 catch(e){if(e.message!=='PREVIEW_EXIT')throw e;}
 return {live,writes,logs};
}
test('preview never writes and accepts normal values',async()=>{
 const r=await run(['--member','25','--developer','40']);
 assert.equal(r.writes,0);
 assert.equal(r.live.length,bindings.length);
});
test('apply preserves every unrelated binding including secrets',async()=>{
 const r=await run(['--member','40','--developer','40','--apply']);
 assert.equal(r.writes,1);
 assert.equal(r.live.length,bindings.length+1);
 assert.equal(r.live.find(x=>x.name==='WHOOP_MEMBER_LIMIT_PER_MINUTE').text,'40');
 for(const b of bindings.filter(x=>x.name!=='WHOOP_MEMBER_LIMIT_PER_MINUTE'))
  assert.deepEqual(JSON.parse(JSON.stringify(r.live.find(x=>x.name===b.name))),b);
});
test('rejects missing critical bindings before any write',async()=>{
 await assert.rejects(run(['--member','40','--apply'],{initial:bindings.filter(x=>x.name!=='DB')}),/Critical binding missing/);
});
test('rejects concurrent deployment changes before write',async()=>{
 await assert.rejects(run(['--member','40','--apply'],{changedDeployment:true}),/Production changed/);
});
test('rejects invalid and out-of-range values',async()=>{
 for(const value of ['0','-1','1.5','101','abc'])
  await assert.rejects(run(['--member',value,'--apply']),/integer from 1 to 100/);
});
