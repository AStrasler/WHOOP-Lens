// Exercise the deployed wrapper and pinned OAuthResourceServer, not only the router.
import './replay-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from '../d1-sqlite.mjs';
const {default:resource}=await import('../../oauth/resource/src/index.mjs');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUDIENCE='https://whooplens.tech/mcp';
const PATHS=['/v1/status','/v1/recovery','/v1/sleep','/v1/whoop/connect','/v1/whoop/profile','/v1/whoop/measurements','/v1/whoop/recovery','/v1/whoop/sleep','/v1/whoop/workouts','/v1/whoop/cycles','/v1/health-connect','/v1/health-connect/import','/v1/health-connect/status','/v1/health-connect/sync-status','/v1/health-connect/sync','/v1/health-connect/pause','/v1/preferences/life-schedule','/v1/announcements','/v1/announcements/manage','/v1/announcements/update'];
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync(new URL('../../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../../migrations/'+f,import.meta.url),'utf8'));
 for(const id of [A,B]){sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);}
 let calls=0;
 const env={DB:d1Database(sqlite),OAUTH_RESOURCE_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',MIGRATION_API_ENABLED:'true',WEB_HEALTH_IMPORT_ENABLED:'true',LIFE_SCHEDULE_ENABLED:'true',AUTH_SERVER:{async validateToken(audience,token){
  calls++;assert.equal(audience,AUDIENCE);
  if(![A,B,'expired','wrong-audience','no-scope'].includes(token))return null;
  return {audience:token==='wrong-audience'?'https://other.invalid/mcp':AUDIENCE,expiresAt:Math.floor(Date.now()/1000)+(token==='expired'?-10:600),scope:token==='no-scope'?[]:['mcp:read'],props:{userId:token===B?B:A}};
 }}};
 const send=(path,{token=A,method='GET',body,headers={},extra={}}={})=>resource.fetch(new Request('https://whooplens.tech'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),{...env,...extra},{});
 return {sqlite,env,send,calls:()=>calls};
}
test('all allowlisted Android APIs require the canonical MCP bearer',async()=>{
 const f=fixture();try{for(const path of PATHS){const r=await f.send(path,{token:null});assert.equal(r.status,401,path);assert.match(r.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/);}assert.equal(f.calls(),0);}finally{f.sqlite.close();}
});
test('API adapter enforces token validity, expiry, audience, scope and membership',async()=>{
 const f=fixture();try{
  for(const path of ['/v1/preferences/life-schedule','/v1/health-connect/sync-status']){
   for(const token of ['invalid','expired','wrong-audience'])assert.equal((await f.send(path,{token})).status,401,path+' '+token);
   assert.equal((await f.send(path,{token:'no-scope'})).status,403);
  }
  f.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
  assert.equal((await f.send('/v1/preferences/life-schedule')).status,403);
 }finally{f.sqlite.close();}
});
test('real OAuth wrapper reaches Life Schedule defaults and isolated explicit writes',async()=>{
 const f=fixture();try{
  const path='/v1/preferences/life-schedule';
  const initial=await f.send(path);assert.equal(initial.status,200);assert.equal((await initial.json()).life_schedule,'unpredictable');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM member_life_schedule').get().n,0);
  assert.equal((await f.send(path,{method:'PUT',body:{life_schedule:'fixed',confirmation:'user_selected_life_schedule',user_id:B}})).status,400);
  assert.equal((await f.send(path,{method:'PUT',body:{life_schedule:'fixed',confirmation:'user_selected_life_schedule'}})).status,200);
  assert.equal((await (await f.send(path)).json()).life_schedule,'fixed');
  assert.equal((await (await f.send(path,{token:B})).json()).life_schedule,'unpredictable');
  assert.equal((await f.send(path,{method:'PUT',body:{life_schedule:'flexible'}})).status,400);
  assert.equal((await f.send(path,{method:'PUT',body:{life_schedule:'flexible',confirmation:'user_selected_life_schedule'},headers:{origin:'https://foreign.invalid'}})).status,403);
 }finally{f.sqlite.close();}
});
function preview(){const now=new Date().toISOString();return {schema_version:2,source:'health_connect',exported_at:now,records:[{metric:'steps_daily',record_key:'daily:2026-10-31:local',observed_at:now,local_date:'2026-10-31',unit:'steps',payload:{count:123}}]};}
test('real wrapper sync is consented, duplicate-safe and isolated; feature-off revocation remains available',async()=>{
 const f=fixture();try{
  for(const token of [A,B]){
   const ready=await f.send('/v1/health-connect/sync-status',{token});assert.equal(ready.status,200);assert.equal((await ready.json()).sync_protocol,1);
   assert.equal((await f.send('/v1/health-connect/sync',{token,method:'POST',body:{file:preview()}})).status,400);
   for(let n=0;n<2;n++)assert.equal((await f.send('/v1/health-connect/sync',{token,method:'POST',body:{consent:'store-health-connect-file',file:preview(),user_id:B}})).status,200);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records').get().n,2);
  const off={WEB_HEALTH_IMPORT_ENABLED:'false'};
  assert.equal((await f.send('/v1/health-connect/pause',{method:'POST',body:{consent:'pause-my-health-connect-sync'},extra:off})).status,200);
  assert.equal((await f.send('/v1/health-connect',{method:'DELETE',body:{consent:'delete-my-health-connect-records'},extra:off})).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(A).n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(B).n,1);
  assert.equal((await f.send('/v1/health-connect/sync-status',{extra:off})).status,503);
 }finally{f.sqlite.close();}
});
test('adapter does not expose unknown routes, foreign origins or caller-selected internal dispatch',async()=>{
 const f=fixture();try{
  for(const path of ['/v1/unknown','/v1/preferences/life-schedule/extra','/mcp/__companion'])assert.equal((await f.send(path,{headers:{'x-original-path':'/v1/preferences/life-schedule'}})).status,404);
  const foreign=await resource.fetch(new Request('https://foreign.invalid/v1/preferences/life-schedule',{headers:{authorization:'Bearer '+A}}),f.env,{});assert.equal(foreign.status,404);
  assert.equal((await f.send('/v1/preferences/life-schedule',{headers:{'Early-Data':'1'}})).status,425);
 }finally{f.sqlite.close();}
});
