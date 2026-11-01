import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {AccessDenied} from '../src/access-denied.mjs';
import {pauseCompanionSync,COMPANION_PAUSE_CONFIRMATION} from '../src/companion-sync.mjs';
import {handleMcpRpc} from '../src/mcp.mjs';
import {hostInstructionsFor} from '../src/host-instructions.mjs';
import {issueIngestToken,ISSUE_CONSENT} from '../src/health-connect-webhook.mjs';
import {healthImportAdmission} from '../src/health-consent-fence.mjs';
import {importHealthConnectFile} from '../src/health-import.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const env={MIGRATION_API_ENABLED:'true',WEB_HEALTH_IMPORT_ENABLED:'true',LIFE_SCHEDULE_ENABLED:'true'};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 for(const id of [A,B]){sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);}
 return {sqlite,...d1Database(sqlite)};
}
function file(){const now=new Date().toISOString();return {schema_version:2,source:'health_connect',exported_at:now,records:[
 {metric:'steps_daily',record_key:'daily:2026-10-31:local',observed_at:now,local_date:'2026-10-31',unit:'steps',payload:{count:123}},
 {metric:'heart_rate',record_key:'heart:one',observed_at:now,origin_package:'com.example.writer',unit:'bpm',payload:{bpm:70}},
 {metric:'sleep_session',record_key:'sleep:one',observed_at:now,ended_at:now,unit:'seconds',payload:{duration_seconds:3600}},
 {metric:'exercise_session',record_key:'exercise:one',observed_at:now,ended_at:now,unit:'seconds',payload:{duration_seconds:100,exercise_type:'Walk'}}]};}
async function http(db,user,method,path,body,extra={}){
 const route=createStagingRouter({verifyIdentity:async req=>{const id=req.headers.get('authorization')?.replace('Bearer ','');if(![A,B].includes(id))throw new AccessDenied(401);return id;}});
 return route(new Request('https://whooplens.tech'+path,{method,headers:{authorization:'Bearer '+(user??''),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),{...env,...extra,DB:db});
}
test('reviewed multi-category manual sync is authenticated, idempotent and isolated',async()=>{
 const db=fixture();try{
  const path='/v1/health-connect/sync',body={consent:'store-health-connect-file',file:file(),user_id:B};
  assert.equal((await http(db,null,'POST',path,body)).status,401);
  assert.equal((await http(db,A,'POST',path,{file:file()})).status,400);
  assert.equal((await http(db,A,'POST',path,body,{WEB_HEALTH_IMPORT_ENABLED:'false'})).status,503);
  const first=await (await http(db,A,'POST',path,body)).json();assert.equal(first.stored,4);assert.equal(first.sync_protocol,1);assert.ok(Date.parse(first.synced_at));
  assert.equal((await http(db,A,'POST',path,body)).status,200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(A).n,4);
  const mine=await (await http(db,A,'GET','/v1/health-connect/sync-status')).json();
  assert.equal(mine.stored_records,4);assert.equal(mine.paused,false);assert.equal(mine.manual_only,true);assert.ok(mine.last_sync_at);
  const other=await (await http(db,B,'GET','/v1/health-connect/sync-status')).json();assert.equal(other.stored_records,0);assert.equal(other.last_sync_at,null);
 }finally{db.sqlite.close();}
});
test('pause retains data, revokes tokens and fences admitted writes; withdrawal removes only caller data',async()=>{
 const db=fixture();try{
  for(const id of [A,B])assert.equal((await http(db,id,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
  const generation=await healthImportAdmission(db,A);
  assert.equal((await http(db,A,'POST','/v1/health-connect/pause',{consent:'wrong'})).status,400);
  const paused=await pauseCompanionSync(db,A,env,'pause-my-health-connect-sync');assert.equal(paused.records_retained,true);
  await assert.rejects(()=>importHealthConnectFile(db,A,file(),'store-health-connect-file',{generation}));
  const state=await (await http(db,A,'GET','/v1/health-connect/sync-status')).json();assert.equal(state.paused,true);assert.equal(state.stored_records,4);
  const withdrawn=await (await http(db,A,'DELETE','/v1/health-connect',{consent:'delete-my-health-connect-records'})).json();assert.equal(withdrawn.deleted,4);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(B).n,4);
 }finally{db.sqlite.close();}
});
test('missing lifecycle schema and inactive membership never advertise readiness',async()=>{
 const db=fixture();try{
  db.sqlite.exec('DROP TRIGGER health_connect_member_removed');
  const migration=await http(db,A,'GET','/v1/health-connect/sync-status');assert.equal(migration.status,503);assert.equal((await migration.json()).code,'migration_required');
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,503);
  db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
  assert.equal((await http(db,A,'GET','/v1/health-connect/sync-status')).status,403);
 }finally{db.sqlite.close();}
});
test('Life Schedule reports disabled activation and missing storage distinctly',async()=>{
 const db=fixture();try{
  const off=await http(db,A,'GET','/v1/preferences/life-schedule',undefined,{LIFE_SCHEDULE_ENABLED:'false'});assert.equal((await off.json()).code,'feature_disabled');
  db.sqlite.exec('DROP TABLE member_life_schedule');
  const missing=await http(db,A,'GET','/v1/preferences/life-schedule');assert.equal(missing.status,503);assert.equal((await missing.json()).code,'migration_required');
 }finally{db.sqlite.close();}
});

test('token consent grants cannot invent or overwrite a successful companion sync time',async()=>{
 const db=fixture();try{
  db.sqlite.prepare("INSERT INTO health_import_consent VALUES(?,'health_connect_file','2026-10-31T01:00:00Z',NULL)").run(A);
  const state=async()=> (await http(db,A,'GET','/v1/health-connect/sync-status')).json();
  assert.equal((await state()).last_sync_at,null);
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
  const synced=(await state()).last_sync_at;assert.ok(synced);
  // This is the consent update performed during webhook-token issuance/rotation.
  db.sqlite.prepare("UPDATE health_import_consent SET granted_at='2026-10-31T23:59:00Z' WHERE user_id=?").run(A);
  assert.equal((await state()).last_sync_at,synced);
  await pauseCompanionSync(db,A,env,'pause-my-health-connect-sync');assert.equal((await state()).last_sync_at,synced);
  await http(db,A,'DELETE','/v1/health-connect',{consent:'delete-my-health-connect-records'});
  assert.equal((await state()).last_sync_at,null);
 }finally{db.sqlite.close();}
});
test('failed import rolls back the sync timestamp and rows together',async()=>{
 const db=fixture();try{
  db.sqlite.exec("CREATE TRIGGER reject_synthetic_import BEFORE INSERT ON health_connect_records BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,503);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM companion_sync_status').get().n,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records').get().n,0);
 }finally{db.sqlite.close();}
});

test('empty previews cannot manufacture a successful sync timestamp',async()=>{
 const db=fixture();try{
  const preview=file();preview.records=[];
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:preview})).status,400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM companion_sync_status').get().n,0);
 }finally{db.sqlite.close();}
});

test('disabled uploads preserve authenticated pause and withdrawal, isolation and in-flight fences',async()=>{
 const db=fixture();try{
  for(const id of [A,B]){
   assert.equal((await http(db,id,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
   db.sqlite.prepare('INSERT INTO health_connect_ingest_tokens(token_hash,user_id) VALUES(?,?)').run((id===A?'a':'b').repeat(64),id);
  }
  const off={WEB_HEALTH_IMPORT_ENABLED:'false'};
  for(const [method,path,consent] of [['POST','/v1/health-connect/pause','pause-my-health-connect-sync'],['DELETE','/v1/health-connect','delete-my-health-connect-records']]){
   assert.equal((await http(db,null,method,path,{consent},off)).status,401);
   assert.equal((await http(db,A,method,path,{consent:'wrong'},off)).status,400);
  }
  const beforePause=await healthImportAdmission(db,A);
  assert.equal((await http(db,A,'POST','/v1/health-connect/pause',{consent:'pause-my-health-connect-sync',user_id:B},off)).status,200);
  await assert.rejects(()=>importHealthConnectFile(db,A,file(),'store-health-connect-file',{generation:beforePause}));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(A).n,4);
  assert.ok(db.sqlite.prepare('SELECT revoked_at FROM health_connect_ingest_tokens WHERE user_id=?').get(A).revoked_at);
  assert.equal(db.sqlite.prepare('SELECT revoked_at FROM health_connect_ingest_tokens WHERE user_id=?').get(B).revoked_at,null);
  const beforeWithdrawal=await healthImportAdmission(db,A);
  assert.equal((await http(db,A,'DELETE','/v1/health-connect',{consent:'delete-my-health-connect-records',user_id:B},off)).status,200);
  await assert.rejects(()=>importHealthConnectFile(db,A,file(),'store-health-connect-file',{generation:beforeWithdrawal}));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(A).n,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM companion_sync_status WHERE user_id=?').get(A).n,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(B).n,4);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM companion_sync_status WHERE user_id=?').get(B).n,1);
  assert.equal(db.sqlite.prepare('SELECT withdrawn_at FROM health_import_consent WHERE user_id=?').get(B).withdrawn_at,null);
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()},off)).status,503);
  assert.equal((await http(db,A,'GET','/v1/health-connect/sync-status',undefined,off)).status,503);
  db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
  assert.equal((await http(db,A,'POST','/v1/health-connect/pause',{consent:'pause-my-health-connect-sync'},off)).status,403);
  assert.equal((await http(db,A,'DELETE','/v1/health-connect',{consent:'delete-my-health-connect-records'},off)).status,403);
 }finally{db.sqlite.close();}
});

// #121 MCP parity: sync status and a non-destructive pause, without the phone.
const MCP_ENV={...env,MCP_ENABLED:'true'};
const mcp=(db,userId,name,args={},extra={})=>handleMcpRpc({jsonrpc:'2.0',id:9,method:'tools/call',params:{name,arguments:args}},
 {db,userId,env:{...MCP_ENV,...extra},whoopRequest:async()=>{throw Error('companion tools never read WHOOP');}},{modern:true});
const listed=async(db,extra)=>(await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/list',params:{}},
 {db,userId:A,env:{...MCP_ENV,...extra},whoopRequest:async()=>({records:[]})},{modern:false})).result.tools;
const tokens=(db,id)=>db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_ingest_tokens WHERE user_id=? AND revoked_at IS NULL').get(id).n;
const consent=(db,id)=>db.sqlite.prepare("SELECT withdrawn_at FROM health_import_consent WHERE user_id=?").get(id)?.withdrawn_at??null;
const records=(db,id)=>db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(id).n;

test('companion MCP tools follow the feature flags and declare honest annotations',async()=>{
 const db=fixture();try{
  const names=async extra=>(await listed(db,extra)).map(t=>t.name).filter(n=>/companion/.test(n)).sort();
  assert.deepEqual(await names({WEB_HEALTH_IMPORT_ENABLED:'false'}),[]);
  assert.deepEqual(await names({}),['get_companion_sync_status','pause_companion_sync']);
  // Phone ingest alone can hold consent and tokens, so pause stays reachable; status does not.
  assert.deepEqual(await names({WEB_HEALTH_IMPORT_ENABLED:'false',HEALTH_CONNECT_WEBHOOK_ENABLED:'true'}),['pause_companion_sync']);
  const hidden=await mcp(db,A,'get_companion_sync_status',{},{WEB_HEALTH_IMPORT_ENABLED:'false',HEALTH_CONNECT_WEBHOOK_ENABLED:'true'});
  assert.equal(hidden.error.code,-32602);
  assert.equal((await mcp(db,A,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION},{WEB_HEALTH_IMPORT_ENABLED:'false'})).error.code,-32602);
  const tools=await listed(db,{});
  const status=tools.find(t=>t.name==='get_companion_sync_status'),pause=tools.find(t=>t.name==='pause_companion_sync');
  assert.equal(status.annotations.readOnlyHint,true);assert.equal(status.annotations.destructiveHint,false);
  assert.equal(pause.annotations.readOnlyHint,false);assert.equal(pause.annotations.destructiveHint,true);
  assert.deepEqual(pause.inputSchema.required,['confirm']);assert.equal(pause.inputSchema.additionalProperties,false);
  assert.match(pause.description,/explicitly asks/);assert.match(pause.description,/records are kept/);
  assert.match(hostInstructionsFor(MCP_ENV),/pause_companion_sync only when the member explicitly asks/);
  assert.doesNotMatch(hostInstructionsFor({...MCP_ENV,WEB_HEALTH_IMPORT_ENABLED:'false'}),/pause_companion_sync|get_companion_sync_status/);
 }finally{db.sqlite.close();}
});

test('get_companion_sync_status is read-only, caller-scoped and returns no health records',async()=>{
 const db=fixture();try{
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
  const before=db.sqlite.prepare('SELECT * FROM health_import_consent ORDER BY user_id').all();
  const mine=(await mcp(db,A,'get_companion_sync_status')).result.structuredContent;
  assert.equal(mine.stored_records,4);assert.equal(mine.paused,false);assert.ok(mine.last_sync_at);
  assert.deepEqual(mine.categories,['steps','heart','sleep','exercise']);
  assert.ok(!('records' in mine));assert.doesNotMatch(JSON.stringify(mine),/bpm|com\.example|payload/);
  const other=(await mcp(db,B,'get_companion_sync_status')).result.structuredContent;
  assert.equal(other.stored_records,0);assert.equal(other.last_sync_at,null);assert.equal(other.paused,true);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM health_import_consent ORDER BY user_id').all(),before);
  for(const bad of [{user_id:B},{confirm:COMPANION_PAUSE_CONFIRMATION},[]])
   assert.equal((await mcp(db,A,'get_companion_sync_status',bad)).error.code,-32602);
 }finally{db.sqlite.close();}
});

test('pause_companion_sync needs the exact confirmation, keeps records and only touches the caller',async()=>{
 const db=fixture();try{
  for(const id of [A,B]){
   assert.equal((await http(db,id,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
   await issueIngestToken(db,id,ISSUE_CONSENT);
  }
  for(const bad of [{},{confirm:'yes'},{confirm:COMPANION_PAUSE_CONFIRMATION,user_id:B},{confirm:'delete-my-health-connect-records'}]){
   assert.equal((await mcp(db,A,'pause_companion_sync',bad)).error.code,-32602);
  }
  assert.equal(tokens(db,A),1);assert.equal(consent(db,A),null);
  const paused=(await mcp(db,A,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION})).result.structuredContent;
  assert.equal(paused.paused,true);assert.equal(paused.records_retained,true);assert.equal(paused.ingest_tokens_revoked,1);
  assert.equal(paused.changed_by,'member_request');
  assert.equal(records(db,A),4);assert.equal(tokens(db,A),0);assert.ok(consent(db,A));
  assert.equal(records(db,B),4);assert.equal(tokens(db,B),1);assert.equal(consent(db,B),null);
  assert.equal((await mcp(db,A,'get_companion_sync_status')).result.structuredContent.paused,true);
  const again=(await mcp(db,A,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION})).result.structuredContent;
  assert.equal(again.ingest_tokens_revoked,0);assert.equal(records(db,A),4);
  // The member resumes from the phone app: the next manual sync re-grants consent.
  assert.equal((await http(db,A,'POST','/v1/health-connect/sync',{consent:'store-health-connect-file',file:file()})).status,200);
  assert.equal((await mcp(db,A,'get_companion_sync_status')).result.structuredContent.paused,false);
 }finally{db.sqlite.close();}
});

test('companion MCP failures are safe and say nothing changed',async()=>{
 const db=fixture();try{
  db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
  const inactive=await mcp(db,A,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION});
  assert.equal(inactive.result.isError,true);
  assert.equal(inactive.result.content[0].text,'Companion sync is only available to active members. Nothing was changed.');
  db.sqlite.prepare('UPDATE whoop_members SET active=1 WHERE user_id=?').run(A);
  db.sqlite.exec('DROP TRIGGER health_connect_member_removed');
  const missing=await mcp(db,A,'get_companion_sync_status');
  assert.equal(missing.result.content[0].text,'Companion sync is not set up on this server yet.');
  const pause=await mcp(db,A,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION});
  assert.match(pause.result.content[0].text,/not set up[\s\S]*Nothing was changed\.$/);
  assert.doesNotMatch(JSON.stringify([missing,pause]),/sqlite|SELECT|trigger|stack/i);
 }finally{db.sqlite.close();}
});
