import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {healthConnectWebhook,issueIngestToken,revokeIngestTokens,ISSUE_CONSENT,REVOKE_CONFIRM} from '../../src/health-connect-webhook.mjs';
import {withdrawHealthConnectImport,WITHDRAW_CONSENT} from '../../src/health-import.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response("")}}',compatibilityDate:'2026-07-29',d1Databases:{DB:'synthetic-health-replay'}});
 const db=await mf.getD1Database('DB');
 for(const name of ['0001_initial.sql','0006_health_import_consent.sql','0022_health_import_fences.sql','0007_health_connect_ingest.sql'])
  await db.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\n/g,' '));
 for(const [id,active] of [[A,1],[B,1],[C,0]]){
  await db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?1,'cloudflare_access',?1)").bind(id).run();
  await db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?1,?2)').bind(id,active).run();
 }
 const issue=async user=>(await issueIngestToken(db,user,ISSUE_CONSENT)).header_value.slice(7);
 const payload=count=>({timestamp:'2026-10-13T03:00:00.000Z',app_version:'1.9.22',user_id:B,steps:[{count,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',metadata:{id:'synthetic-duplicate',lastModifiedTime:'2026-10-13T02:00:00Z'}}]});
 const post=(token,count=42,storage=db)=>healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(payload(count))}),{DB:storage,HEALTH_CONNECT_WEBHOOK_ENABLED:'true'},{now:Date.parse('2026-10-13T03:00:00Z')});
 const count=async user=>(await db.prepare('SELECT count(*) n FROM health_connect_records WHERE user_id=?1').bind(user).first()).n;
 return {mf,db,issue,post,count};
}
test('real D1 Health Connect: simultaneous duplicates are idempotent and ignore foreign user_id',async()=>{
 const f=await fixture();try{
  const token=await f.issue(A),other=await f.issue(B);
  assert.equal((await f.post(other,77)).status,200);
  const responses=await Promise.all([f.post(token),f.post(token),f.post(token)]);
  assert.deepEqual(responses.map(r=>r.status),[200,200,200]);
  assert.equal(await f.count(A),1);assert.equal(await f.count(B),1);assert.equal(await f.count(C),0);
  const row=await f.db.prepare('SELECT payload_json FROM health_connect_records WHERE user_id=?1').bind(B).first();assert.equal(JSON.parse(row.payload_json).count,77);
 }finally{await f.mf.dispose();}
});
for(const action of ['revoke','withdraw','rotate','membership']){
 test('real D1 Health Connect: '+action+' before commit rejects a previously authorized upload',async()=>{
  const f=await fixture(),entered=deferred(),release=deferred();try{
   const token=await f.issue(A),other=await f.issue(B);assert.equal((await f.post(other,77)).status,200);
   const paused={prepare:f.db.prepare.bind(f.db),async batch(statements){entered.resolve();await release.promise;return f.db.batch(statements);}};
   const pending=f.post(token,42,paused);await entered.promise;
   if(action==='revoke')await revokeIngestTokens(f.db,A,REVOKE_CONFIRM);
   if(action==='withdraw')await withdrawHealthConnectImport(f.db,A,WITHDRAW_CONSENT);
   if(action==='rotate')await f.issue(A);
   if(action==='membership')await f.db.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?1').bind(A).run();
   release.resolve();assert.equal((await pending).status,403);
   assert.equal(await f.count(A),0);assert.equal(await f.count(B),1);
  }finally{release.resolve();await f.mf.dispose();}
 });
}
test('real D1 Health Connect: inactive member gets no token and revoked token stays invalid after renewed consent',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.issue(C));
  const stale=await f.issue(A);await revokeIngestTokens(f.db,A,REVOKE_CONFIRM);
  const current=await f.issue(A);
  assert.equal((await f.post(stale)).status,401);assert.equal(await f.count(A),0);
  assert.equal((await f.post(current)).status,200);assert.equal(await f.count(A),1);
 }finally{await f.mf.dispose();}
});


const webFile={schema_version:2,source:'health_connect',exported_at:'2026-10-13T02:00:00Z',records:[{metric:'steps_daily',record_key:'synthetic:web-file',observed_at:'2026-10-12T00:00:00Z',ended_at:'2026-10-13T00:00:00Z',local_date:'2026-10-12',unit:'steps',payload:{count:42}}]};
for(const action of ['membership','withdraw']){
 test('real D1 web file: '+action+' before commit cannot be undone by an older import',async()=>{
  const f=await fixture(),entered=deferred(),release=deferred();try{
   const {importHealthConnectFile,IMPORT_CONSENT}=await import('../../src/health-import.mjs');
   const paused={prepare:f.db.prepare.bind(f.db),async batch(statements){entered.resolve();await release.promise;return f.db.batch(statements);}};
   const pending=importHealthConnectFile(paused,A,webFile,IMPORT_CONSENT,{now:Date.parse('2026-10-13T03:00:00Z')});
   const observed=pending.then(value=>({value}),error=>({error}));
   await entered.promise;
   if(action==='membership')await f.db.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?1').bind(A).run();
   else await withdrawHealthConnectImport(f.db,A,WITHDRAW_CONSENT);
   release.resolve();const result=await observed;
   assert.equal(await f.count(A),0,'no health writes after withdrawal or membership removal');
   assert.ok(result.error,'stale import must fail closed');
  }finally{release.resolve();await f.mf.dispose();}
 });
}


for(const action of ['membership','withdraw','revoke']){
 test('real D1 token issuance: '+action+' cancels a previously admitted rotation',async()=>{
  const f=await fixture(),entered=deferred(),release=deferred();try{
   const paused={prepare:f.db.prepare.bind(f.db),async batch(statements){entered.resolve();await release.promise;return f.db.batch(statements);}};
   const pending=issueIngestToken(paused,A,ISSUE_CONSENT).then(value=>({value}),error=>({error}));
   await entered.promise;
   if(action==='membership')await f.db.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?1').bind(A).run();
   if(action==='withdraw')await withdrawHealthConnectImport(f.db,A,WITHDRAW_CONSENT);
   if(action==='revoke')await revokeIngestTokens(f.db,A,REVOKE_CONFIRM);
   release.resolve();const result=await pending;
   const row=await f.db.prepare('SELECT count(*) n FROM health_connect_ingest_tokens WHERE user_id=?1 AND revoked_at IS NULL').bind(A).first();
   assert.equal(row.n,0);assert.ok(result.error);
  }finally{release.resolve();await f.mf.dispose();}
 });
}


test('real D1 web HTTP: withdrawal during body transfer cancels import; a later explicit import may regrant',async()=>{
 const f=await fixture(),admitted=deferred(),release=deferred();try{
  const {healthConnectHttp,importHealthConnectFile,IMPORT_CONSENT}=await import('../../src/health-import.mjs');
  const db={batch:f.db.batch.bind(f.db),prepare(sql){
   const statement=f.db.prepare(sql);
   if(!sql.startsWith('SELECT generation FROM health_import_fences'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();admitted.resolve();return row;}};}};
  }};
  const body=new ReadableStream({async pull(controller){await release.promise;controller.enqueue(new TextEncoder().encode(JSON.stringify({file:webFile,consent:IMPORT_CONSENT})));controller.close();}});
  const pending=healthConnectHttp(new Request('https://whooplens.tech/v1/health-connect/import',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'}),{DB:db,WEB_HEALTH_IMPORT_ENABLED:'true'},A);
  await admitted.promise;await withdrawHealthConnectImport(f.db,A,WITHDRAW_CONSENT);release.resolve();
  assert.equal((await pending).status,503);assert.equal(await f.count(A),0);
  const fresh=await importHealthConnectFile(f.db,A,webFile,IMPORT_CONSENT,{now:Date.parse('2026-10-13T03:00:00Z')});
  assert.equal(fresh.stored,1);assert.equal(await f.count(A),1);
 }finally{release.resolve();await f.mf.dispose();}
});
