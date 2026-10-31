import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {AccessDenied} from '../src/access-denied.mjs';
import {pauseCompanionSync} from '../src/companion-sync.mjs';
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
