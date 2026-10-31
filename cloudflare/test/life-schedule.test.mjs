import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {handleMcpRpc} from '../src/mcp.mjs';
import {AccessDenied} from '../src/access-denied.mjs';
import {readLifeSchedule,selectLifeSchedule,effectiveLifeSchedule} from '../src/life-schedule.mjs';
import {buildLifeScheduleInsights} from '../src/life-schedule-insights.mjs';
import {attachSummary} from '../src/ai-summary.mjs';
import {buildWeeklyDigest} from '../src/ai-digest.mjs';
const A='0a0a0a0a-0000-4000-8000-00000000000a',B='0b0b0b0b-0000-4000-8000-00000000000b',INACTIVE='0c0c0c0c-0000-4000-8000-00000000000c';
const ON={MIGRATION_API_ENABLED:'true',LIFE_SCHEDULE_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true'};
const NOW=Date.parse('2026-10-31T18:00:00Z');
function database(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 for(const id of [A,B,INACTIVE]){
  sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
  sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,id===INACTIVE?0:1);
 }
 return {sqlite,...d1Database(sqlite)};
}
const selection=value=>({life_schedule:value,confirmation:'user_selected_life_schedule'});
async function request(db,id,method='GET',body,headers={}){
 const router=createStagingRouter({verifyIdentity:async req=>{
  const id=req.headers.get('authorization')?.replace('Bearer ','');
  if(![A,B,INACTIVE].includes(id))throw new AccessDenied(401);
  return id;
 }});
 return router(new Request('https://whooplens.tech/v1/preferences/life-schedule',{method,headers:{...(id?{authorization:'Bearer '+id}:{}),'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),{...ON,DB:db});
}
function records(){
 const out=[];
 for(let i=0;i<30;i++){
  const end=new Date(NOW-i*86400000).toISOString();
  out.push({id:'sleep-'+i,start:new Date(NOW-i*86400000-6*3600000).toISOString(),end,timezone_offset:'-04:00',score:{sleep_efficiency_percentage:85,sleep_consistency_percentage:20,stage_summary:{total_light_sleep_time_milli:3*3600000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:2*3600000},sleep_needed:{baseline_milli:8*3600000,need_from_sleep_debt_milli:3600000,need_from_recent_strain_milli:0,need_from_recent_nap_milli:0}}});
  out.push({id:'recovery-'+i,created_at:end,score:{recovery_score:50+i,hrv_rmssd_milli:40+i,resting_heart_rate:60-i/10}});
  out.push({id:'cycle-'+i,end,score:{strain:10+i/10}});
  out.push({id:'workout-'+i,end,sport_id:1,score:{kilojoule:500}});
 }
 return out;
}
test('unset and invalid preferences use unpredictable without read-side writes',async()=>{
 const db=database();try{
  for(const id of [A,B])assert.deepEqual(await readLifeSchedule(db,id,{env:ON}),{life_schedule:'unpredictable',explicit:false,revision:null});
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM member_life_schedule').get().n,0);
  db.sqlite.exec('PRAGMA ignore_check_constraints=ON');
  db.sqlite.prepare("INSERT INTO member_life_schedule VALUES(?,'inferred','invalid','now')").run(A);
  assert.equal((await readLifeSchedule(db,A,{env:ON})).life_schedule,'unpredictable');
  assert.equal(db.sqlite.prepare('SELECT life_schedule FROM member_life_schedule').get().life_schedule,'inferred');
  for(const value of [null,undefined,'','FIXED','observed'])assert.equal(effectiveLifeSchedule(value),'unpredictable');
 }finally{db.sqlite.close();}
});
for(const value of ['fixed','flexible','unpredictable'])test(value+' persists only for the authenticated member',async()=>{
 const db=database();try{
  assert.equal((await request(db,A,'PUT',selection(value))).status,200);
  const saved=await (await request(db,A)).json();
  assert.equal(saved.life_schedule,value);assert.equal(saved.explicit,true);
  assert.equal((await readLifeSchedule({...d1Database(db.sqlite)},A,{env:ON})).life_schedule,value);
  assert.equal((await readLifeSchedule(db,B,{env:ON})).explicit,false);
 }finally{db.sqlite.close();}
});
test('unauthorized, inactive, inferred, cross-account and unconfirmed changes are refused',async()=>{
 const db=database();try{
  assert.equal((await request(db,null,'PUT',selection('fixed'))).status,401);
  assert.equal((await request(db,INACTIVE,'PUT',selection('fixed'))).status,403);
  for(const body of [{life_schedule:'fixed'},{...selection('fixed'),user_id:B},{...selection('fixed'),source:'analysis'},selection('random')])
   assert.equal((await request(db,A,'PUT',body)).status,400);
  assert.equal((await request(db,A,'PUT',selection('fixed'),{origin:'https://evil.example'})).status,403);
  assert.equal((await request(db,A,'POST',selection('fixed'))).status,405);
  await assert.rejects(()=>selectLifeSchedule(db,A,selection('fixed'),{env:{...ON,LIFE_SCHEDULE_ENABLED:'false'}}));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM member_life_schedule').get().n,0);
 }finally{db.sqlite.close();}
});
test('membership revocation between validation and preference write is fenced',async()=>{
 const db=database();try{
  const wrapped={prepare(sql){const stmt=db.prepare(sql);if(sql.startsWith('INSERT INTO member_life_schedule')){
   const run=stmt.run.bind(stmt);stmt.run=async()=>{db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);return run();};
  }return stmt;}};
  await assert.rejects(()=>selectLifeSchedule(wrapped,A,selection('fixed'),{env:ON}),e=>e.status===403);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM member_life_schedule').get().n,0);
 }finally{db.sqlite.close();}
});
for(const schedule of ['fixed','flexible','unpredictable'])test(schedule+' grounds recommendations and all rolling windows',()=>{
 const result=buildLifeScheduleInsights({schedule,records:records(),now:NOW,complete:true});
 assert.equal(result.life_schedule,schedule);
 assert.deepEqual(result.windows.map(w=>w.days),[7,14,30]);
 for(const window of result.windows){
  assert.equal(window.metrics.sleep_duration_minutes.observed_days,window.days);
  assert.equal(window.metrics.sleep_duration_minutes.mean,360);
  assert.equal(window.metrics.sleep_debt_minutes.latest,60);
  assert.equal(window.metrics.sleep_deficit_minutes.latest,180);
  for(const key of ['sleep_efficiency_percent','sleep_consistency_percent','hrv_ms','resting_heart_rate_bpm','recovery_percent','daily_strain','activity_kilojoules','sleep_start_local_minutes'])assert.ok(window.metrics[key],key);
 }
 assert.ok(result.recommendations.some(s=>s.includes('sleep debt')));
 assert.match(result.limitations.join(' '),/do not establish causation/);
 assert.doesNotMatch(result.recommendations.join(' '),/adopt a fixed|consistent bedtime/);
});
test('irregular timing and low consistency alone never demand a fixed schedule',()=>{
 for(const schedule of ['fixed','flexible','unpredictable']){
  const data=[{id:1,start:'2026-10-30T23:00:00Z',end:'2026-10-31T07:00:00Z',timezone_offset:'+00:00',score:{sleep_consistency_percentage:5,stage_summary:{total_light_sleep_time_milli:100,total_slow_wave_sleep_time_milli:100,total_rem_sleep_time_milli:100}}},
  {id:2,start:'2026-10-29T05:00:00Z',end:'2026-10-29T13:00:00Z',timezone_offset:'+00:00',score:{sleep_consistency_percentage:5,stage_summary:{total_light_sleep_time_milli:100,total_slow_wave_sleep_time_milli:100,total_rem_sleep_time_milli:100}}}];
  const result=buildLifeScheduleInsights({schedule,records:data,now:NOW});
  assert.deepEqual(result.recommendations,[]);
  assert.ok(result.windows[0].metrics.sleep_start_local_minutes.circular_variability_minutes>0);
 }
});
test('sparse, duplicate, future, nap and missing-timezone observations stay honest',()=>{
 const all=records();const one=all[0];
 const result=buildLifeScheduleInsights({records:[one,one,{...one,id:'future',end:'2027-01-01T00:00:00Z'},{...one,id:'nap',nap:true},{...one,id:'bad',end:'invalid',start:'invalid',timezone_offset:null}],now:NOW});
 assert.equal(result.windows[0].metrics.sleep_duration_minutes.observed_days,1);
 assert.equal(result.windows[0].metrics.sleep_duration_minutes.change,null);
 assert.equal(result.windows[2].metrics.sleep_duration_minutes.missing_days,29);
 assert.match(result.limitations[0],/incomplete/);
 assert.equal(buildLifeScheduleInsights({records:[],now:NOW}).recommendations.length,0);
});
test('summary context reads the preference and never changes it',async()=>{
 const db=database();try{
  await selectLifeSchedule(db,A,selection('flexible'),{env:ON});
  const before=db.sqlite.prepare('SELECT * FROM member_life_schedule').all();
  const result=await attachSummary({records:records(),complete:true},{db,userId:A,env:ON,tool:'get_recovery',now:NOW});
  assert.equal(result.summary.life_schedule.life_schedule,'flexible');
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM member_life_schedule').all(),before);
 }finally{db.sqlite.close();}
});
test('rollback removes only schedule selections and disabled reads fail closed',async()=>{
 const db=database();try{
  await selectLifeSchedule(db,A,selection('fixed'),{env:ON});
  db.sqlite.exec(readFileSync(new URL('../migration/rollback/0024_life_schedule.down.sql',import.meta.url),'utf8'));
  await assert.rejects(()=>readLifeSchedule(db,A,{env:ON}));
  await assert.rejects(()=>readLifeSchedule(db,A,{env:{...ON,LIFE_SCHEDULE_ENABLED:'false'}}));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM whoop_members').get().n,3);
 }finally{db.sqlite.close();}
});

test('MCP offers read-only schedule insights and refuses AI preference writes',async(t)=>{
 t.mock.method(Date,'now',()=>NOW);
 const db=database();try{
  await selectLifeSchedule(db,A,selection('fixed'),{env:ON});
  const before=db.sqlite.prepare('SELECT * FROM member_life_schedule').all();
  const ctx={db,userId:A,env:ON,whoopRequest:async(_db,id,resource)=>{
   assert.equal(id,A);
   return {records:records().filter(r=>resource==='sleep'?r.id.startsWith('sleep'):resource==='recovery'?r.id.startsWith('recovery'):resource==='cycles'?r.id.startsWith('cycle'):r.id.startsWith('workout')).slice(0,7),next_token:null};
  }};
  const transport={modern:false};
  const rpc=(method,params)=>handleMcpRpc({jsonrpc:'2.0',id:1,method,params},ctx,transport);
  const inventory=await rpc('tools/list',{});
  const tool=inventory.result.tools.find(t=>t.name==='get_life_schedule_insights');
  assert.equal(tool.annotations.readOnlyHint,true);
  assert.equal(inventory.result.tools.some(t=>/set_life|select_life|update_life/.test(t.name)),false);
  assert.ok((await rpc('tools/call',{name:tool.name,arguments:{user_id:B}})).error);
  assert.ok((await rpc('tools/call',{name:'set_life_schedule',arguments:{life_schedule:'flexible'}})).error);
  const result=await rpc('tools/call',{name:tool.name,arguments:{}});
  const data=JSON.parse(result.result.content[0].text);
  assert.equal(data.life_schedule,'fixed');
  assert.equal(data.windows[0].metrics.hrv_ms.observed_days,7);
  assert.equal(data.windows[0].metrics.daily_strain.observed_days,7);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM member_life_schedule').all(),before);
 }finally{db.sqlite.close();}
});

test('weekly digest cache is isolated by explicit preference revision',async()=>{
 const db=database();try{
  const env={...ON,WEEKLY_DIGEST_ENABLED:'true'};
  let calls=0;
  const whoopRequest=async(_db,id,resource)=>{
   assert.equal(id,A);calls++;
   const prefix=resource==='sleep'?'sleep':'recovery';
   return {records:records().filter(r=>r.id.startsWith(prefix)).slice(1,8),next_token:null};
  };
  await selectLifeSchedule(db,A,selection('fixed'),{env});
  const first=await buildWeeklyDigest({db,userId:A,env,whoopRequest,now:NOW,weekEnding:'2026-10-25'});
  assert.equal(first.ok,true);assert.equal(first.life_schedule.life_schedule,'fixed');
  const before=calls;
  const cached=await buildWeeklyDigest({db,userId:A,env,whoopRequest,now:NOW,weekEnding:'2026-10-25'});
  assert.equal(cached.cached,true);assert.equal(calls,before);
  await selectLifeSchedule(db,A,selection('flexible'),{env});
  const changed=await buildWeeklyDigest({db,userId:A,env,whoopRequest,now:NOW,weekEnding:'2026-10-25'});
  assert.equal(changed.ok,true);assert.equal(changed.cached,false);assert.equal(changed.life_schedule.life_schedule,'flexible');
 }finally{db.sqlite.close();}
});

test('both committed Worker configurations keep production activation off',()=>{
 for(const path of ['../wrangler.jsonc','../oauth/resource/wrangler.jsonc']){
  const source=readFileSync(new URL(path,import.meta.url),'utf8');
  assert.match(source,/"LIFE_SCHEDULE_ENABLED"\s*:\s*"false"/);
 }
});
