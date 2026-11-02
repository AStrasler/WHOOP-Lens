// Owner/member MCP boundary and member parity. Synthetic members only (OWNER, MOM, KIM,
// INACTIVE). Every request goes through the real /mcp route with a verified identity.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {AccessDenied} from '../src/access-denied.mjs';
import {OWNER_ONLY_TOOLS,isVerifiedOwner} from '../src/roles.mjs';
import {COMPANION_PAUSE_CONFIRMATION} from '../src/companion-sync.mjs';

const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const MOM='0b0b0b0b-0000-4000-8000-00000000000b';
const KIM='0c0c0c0c-0000-4000-8000-00000000000c';
const INACTIVE='0d0d0d0d-0000-4000-8000-00000000000d';
// Every member-facing flag on, as in production plus announcements.
const PROD={MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',AI_SUMMARY_ENABLED:'true',
  WEEKLY_DIGEST_ENABLED:'true',FLARE_JOURNAL_ENABLED:'true',LIFE_SCHEDULE_ENABLED:'true',NOTION_ENABLED:'true',
  ISSUE_REPORTS_ENABLED:'true',ANNOUNCEMENTS_ENABLED:'true',WEB_HEALTH_IMPORT_ENABLED:'true',
  HEALTH_CONNECT_WEBHOOK_ENABLED:'true',WHOOP_OAUTH_ENABLED:'true',STRESS_ESTIMATE_ENABLED:'true',
  WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
const MEMBER_TOOLS=['get_profile','get_body_measurements','get_recovery','get_sleep','get_workouts','get_cycles',
  'get_samsung_health','get_health_connect','get_medical_context','get_capabilities','connect_whoop','disconnect_whoop',
  'import_health_connect_file','withdraw_health_connect_import','issue_health_connect_ingest_token',
  'revoke_health_connect_ingest_token','get_dashboard_overview','get_account_data_summary','get_ai_usage','get_weekly_digest',
  'set_flare_consent','save_flare_context','save_flare_entry','get_flare_journal','delete_flare_entry','pause_flare_analysis',
  'withdraw_flare_journal','analyze_flare_patterns','get_life_schedule_insights','set_life_schedule',
  'get_companion_sync_status','pause_companion_sync','report_issue','report_error','list_service_announcements',
  'connect_notion','get_notion_status','disconnect_notion','list_notion_databases','get_notion_database_schema',
  'configure_notion_daily_log','get_notion_daily_log','preview_notion_daily_log_update','save_notion_daily_log_update'];

function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  for(const [id,active] of [[OWNER,1],[MOM,1],[KIM,1],[INACTIVE,0]]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,active);
  }
  // A Health Connect record and an issue report for each active member, to prove isolation.
  for(const [id,steps] of [[OWNER,1111],[MOM,2222],[KIM,3333]]){
    sqlite.prepare("INSERT INTO health_connect_records(id,user_id,metric,record_key,observed_at,ended_at,local_date,unit,payload_json) VALUES(?,?,'steps_daily','daily:2026-10-31:local','2026-10-31T05:00:00Z','2026-11-01T04:59:00Z','2026-10-31','steps',?)")
      .run('hc-'+id,id,JSON.stringify({count:steps}));
  }
  return {sqlite,...d1Database(sqlite)};
}
function harness(db,env=PROD,{whoop}={}){
  const revoked=new Set(),whoopCalls=[];
  const route=createStagingRouter({
    verifyIdentity:async req=>{
      const id=req.headers.get('authorization')?.replace('Bearer ','');
      if(![OWNER,MOM,KIM,INACTIVE].includes(id)||revoked.has(id))throw new AccessDenied(401);
      return id;
    },
    whoopRequest:async(_db,userId,resource,_env,args)=>{whoopCalls.push({userId,resource});
      if(whoop)return whoop(userId,resource,args);throw Error('WHOOP API request failed');}
  });
  let n=0;
  const rpc=async(id,method,params={},headers={})=>{
    const res=await route(new Request('https://whooplens.tech/mcp',{method:'POST',headers:{
      ...(id?{authorization:'Bearer '+id}:{}),'content-type':'application/json','accept':'application/json, text/event-stream',...headers},
      body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})}),{...env,DB:db});
    return {status:res.status,body:res.status===200?await res.json():null};
  };
  const call=(id,name,args={},headers)=>rpc(id,'tools/call',{name,arguments:args},headers);
  const names=async id=>(await rpc(id,'tools/list')).body.result.tools.map(t=>t.name);
  return {rpc,call,names,revoked,whoopCalls};
}
const count=(db,sql)=>db.sqlite.prepare(sql).get().n;

test('owner sees member tools plus exactly the owner tools; members see the complete member catalog and none of them',async()=>{
  const db=database();try{
    const h=harness(db);
    const owner=await h.names(OWNER),mom=await h.names(MOM),kim=await h.names(KIM);
    assert.deepEqual([...mom].sort(),[...MEMBER_TOOLS].sort());
    assert.deepEqual(kim,mom,'every member gets the same catalog');
    assert.deepEqual(owner.filter(t=>!mom.includes(t)).sort(),[...OWNER_ONLY_TOOLS].sort());
    assert.ok(mom.every(t=>owner.includes(t)),'the owner keeps every member tool');
    assert.equal(owner.length,MEMBER_TOOLS.length+OWNER_ONLY_TOOLS.size);
  }finally{db.sqlite.close();}
});

test('members calling owner tools directly are rejected like unknown tools and change nothing',async()=>{
  const db=database();try{
    const h=harness(db);
    // Mom files a real report through the member flow (preview, then approved submit).
    const report={category:'other',description:'The dashboard did not load this morning'};
    await h.call(MOM,'report_issue',report);
    const saved=JSON.parse((await h.call(MOM,'report_issue',{...report,approved:true})).body.result.content[0].text);
    const ref=saved.reference;assert.match(ref,/^WL-/);
    const statusOf=()=>db.sqlite.prepare('SELECT status FROM issue_reports WHERE reference=?').get(ref).status;
    const before=[count(db,'SELECT COUNT(*) n FROM service_announcements'),statusOf()];
    const attempts={
      review_issue_reports:{},update_issue_report:{reference:'WL-PLACEHOLD',status:'resolved'},get_reportable_links:{},
      create_service_announcement:{kind:'notice',title:'x',body:'y',audience:'all'},
      update_service_announcement:{id:'x',status:'cancelled'},manage_service_announcements:{}};
    attempts.update_issue_report.reference=ref;
    for(const member of [MOM,KIM])for(const [name,args] of Object.entries(attempts)){
      const r=await h.call(member,name,args);
      assert.equal(r.status,200);assert.equal(r.body.error?.code,-32602,name);assert.equal(r.body.error.message,'Unknown tool');
      assert.equal(r.body.result,undefined,name+' must not run');
    }
    assert.deepEqual([count(db,'SELECT COUNT(*) n FROM service_announcements'),statusOf()],before);
    // The owner can run them.
    const review=await h.call(OWNER,'review_issue_reports',{});
    assert.equal(review.body.result.isError,undefined);
    assert.ok(JSON.parse(review.body.result.content[0].text).reports.some(r=>r.reference===ref));
  }finally{db.sqlite.close();}
});

test('forged role claims, headers, arguments and look-alike identities never grant owner access',async()=>{
  const db=database();try{
    const h=harness(db);
    const forgedHeaders={'x-whoop-lens-role':'owner','x-user-id':OWNER,'x-forwarded-user':OWNER,'cf-access-authenticated-user-email':'owner@example.com'};
    assert.ok(!(await h.names(MOM)).some(t=>OWNER_ONLY_TOOLS.has(t)));
    assert.equal((await h.rpc(MOM,'tools/list',{},forgedHeaders)).body.result.tools.some(t=>OWNER_ONLY_TOOLS.has(t.name)),false);
    for(const args of [{user_id:OWNER},{role:'owner'},{owner:true},{as_user:OWNER},{_meta:{role:'owner'}}]){
      const r=await h.call(MOM,'review_issue_reports',args,forgedHeaders);
      assert.equal(r.body.error?.code,-32602);
      // Member tools with smuggled targeting fields are rejected, not redirected.
      const target=await h.call(MOM,'get_account_data_summary',args);
      assert.equal(target.body.error?.message,'Invalid tool arguments');
    }
    // The owner check is an exact server-side comparison with the verified identity.
    assert.equal(isVerifiedOwner(PROD,OWNER),true);
    for(const forged of [OWNER.toUpperCase(),' '+OWNER,OWNER+' ','',null,undefined,['x'],{id:OWNER}])
      assert.equal(isVerifiedOwner(PROD,forged),false,String(forged));
    assert.equal(isVerifiedOwner({},OWNER),false,'no configured owner means no owner');
    assert.equal(isVerifiedOwner({WHOOP_LENS_DEVELOPER_USER_ID:''},''),false);
    // With the owner setting removed, even the former owner gets the member catalog.
    const noOwner=harness(db,{...PROD,WHOOP_LENS_DEVELOPER_USER_ID:undefined});
    assert.equal((await noOwner.names(OWNER)).some(t=>OWNER_ONLY_TOOLS.has(t)),false);
    assert.equal((await noOwner.call(OWNER,'manage_service_announcements',{})).body.error?.code,-32602);
  }finally{db.sqlite.close();}
});

test('get_capabilities never advertises owner tools or owner permissions to a member',async()=>{
  const db=database();try{
    const h=harness(db);
    for(const [id,ownerExpected] of [[MOM,false],[OWNER,true]]){
      const r=await h.call(id,'get_capabilities',{});
      const data=JSON.parse(r.body.result.content[0].text);
      const owned=data.tool_permissions.filter(t=>t.owner_only).map(t=>t.tool).sort();
      assert.deepEqual(owned,ownerExpected?[...OWNER_ONLY_TOOLS].sort():[]);
      assert.equal(data.tool_permissions.some(t=>OWNER_ONLY_TOOLS.has(t.tool)),ownerExpected);
    }
  }finally{db.sqlite.close();}
});

test('missing, invalid and revoked sessions are refused before any tool runs; inactive members get 403',async()=>{
  const db=database();try{
    const h=harness(db);
    assert.equal((await h.rpc(null,'tools/list')).status,401);
    assert.equal((await h.call('not-a-member','get_account_data_summary')).status,401);
    assert.equal((await h.call(MOM,'get_account_data_summary')).status,200);
    h.revoked.add(MOM);
    assert.equal((await h.rpc(MOM,'tools/list')).status,401);
    assert.equal((await h.call(MOM,'set_life_schedule',{life_schedule:'fixed',confirm:'member-requested-life-schedule-change'})).status,401);
    h.revoked.add(OWNER);
    assert.equal((await h.call(OWNER,'review_issue_reports',{})).status,401,'a revoked owner session is not an owner');
    assert.equal((await h.rpc(INACTIVE,'tools/list')).status,403);
    assert.equal((await h.call(INACTIVE,'get_dashboard_overview')).status,403);
    // Reauthentication: a fresh valid session works again.
    h.revoked.delete(MOM);
    assert.equal((await h.call(MOM,'get_account_data_summary')).status,200);
    assert.equal(count(db,'SELECT COUNT(*) n FROM member_life_schedule'),0);
  }finally{db.sqlite.close();}
});

test('account data summary and Health Connect reads are scoped to the caller',async()=>{
  const db=database();try{
    const h=harness(db);
    await h.call(MOM,'set_life_schedule',{life_schedule:'flexible',confirm:'member-requested-life-schedule-change'});
    await h.call(KIM,'set_life_schedule',{life_schedule:'fixed',confirm:'member-requested-life-schedule-change'});
    const mom=JSON.parse((await h.call(MOM,'get_account_data_summary')).body.result.content[0].text).categories;
    const kim=JSON.parse((await h.call(KIM,'get_account_data_summary')).body.result.content[0].text).categories;
    assert.equal(mom.life_schedule.selection,'flexible');assert.equal(kim.life_schedule.selection,'fixed');
    assert.equal(mom.health_connect_records.stored,1);assert.equal(mom.whoop_connection.connected,false);
    assert.equal(mom.health_connect_records.self_service,'withdraw_health_connect_import');
    const text=JSON.stringify(mom);
    assert.doesNotMatch(text,/2222|3333|1111/,'counts and states only, no values');
    const hc=JSON.parse((await h.call(MOM,'get_health_connect',{})).body.result.content[0].text);
    assert.deepEqual(hc.records.map(r=>JSON.parse(r.payload_json??JSON.stringify(r.payload)).count),[2222]);
  }finally{db.sqlite.close();}
});

test('dashboard overview reads only the caller, labels sources and never fabricates missing values',async()=>{
  const db=database();try{
    // Not connected: no WHOOP call, WHOOP sections missing, Health Connect labeled supplementary.
    let h=harness(db);
    const notConnected=JSON.parse((await h.call(MOM,'get_dashboard_overview')).body.result.content[0].text);
    assert.equal(h.whoopCalls.length,0);
    assert.equal(notConnected.whoop.connected,false);assert.equal(notConnected.whoop.recovery.missing,true);
    assert.equal(notConnected.health_connect.source_authority,'supplementary');
    assert.equal(notConnected.health_connect.daily_steps.value,2222);
    // Connected: values come from the caller's WHOOP reads only; a failed read is reported, not zeroed.
    db.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,'2099-01-01T00:00:00Z','read:recovery','x','y','v1','public')").run(MOM);
    const now=new Date().toISOString();
    h=harness(db,PROD,{whoop:(userId,resource)=>{
      assert.equal(userId,MOM);
      if(resource==='recovery')return {records:[{score_state:'SCORED',created_at:now,score:{recovery_score:67,hrv_rmssd_milli:58.2,resting_heart_rate:54}}]};
      if(resource==='cycles')return {records:[{start:now,score_state:'SCORED',score:{strain:9.1,average_heart_rate:71}}]};
      throw Error('WHOOP API request failed');
    }});
    const o=JSON.parse((await h.call(MOM,'get_dashboard_overview')).body.result.content[0].text);
    assert.equal(o.whoop.recovery.recovery_score.value,67);assert.equal(o.whoop.recovery.spo2.missing,true);
    assert.equal(o.whoop.strain.cycle_open,true);assert.equal(o.whoop.strain.strain.value,9.1);
    assert.deepEqual(o.whoop.unavailable,['sleep']);assert.equal(o.whoop.sleep.missing,true);
    assert.ok(o.notes.some(n=>/missing, not zero/.test(n)));
    assert.ok(h.whoopCalls.every(c=>c.userId===MOM));
  }finally{db.sqlite.close();}
});

test('dashboard daily steps sum the latest local day of interval records instead of returning one bucket',async()=>{
  const db=database();try{
    const insert=(key,observed,ended,localDate,payload)=>db.sqlite.prepare("INSERT INTO health_connect_records(id,user_id,metric,record_key,observed_at,ended_at,local_date,unit,payload_json) VALUES(?,?,'steps_daily',?,?,?,?,'steps',?)")
      .run('hc-'+key,KIM,key,observed,ended,localDate,JSON.stringify(payload));
    // Phone ingest sends 15-minute buckets without a local date (synthetic values).
    insert('b0','2026-11-01T05:45:00.000Z','2026-11-01T06:00:00.000Z',null,{count:999,ingest:'hc_webhook'}); // 23:45 on Oct 31 at -06:00
    insert('b1','2026-11-01T06:00:00.000Z','2026-11-01T06:15:00.000Z',null,{count:100,ingest:'hc_webhook'});
    insert('b2','2026-11-01T20:00:00.000Z','2026-11-01T20:15:00.000Z',null,{count:5000,ingest:'hc_webhook'});
    insert('b3','2026-11-02T03:15:00.000Z','2026-11-02T03:30:00.000Z',null,{count:46,ingest:'hc_webhook'});
    // A file import holding the same local day is not added on top of phone ingest.
    insert('f1','2026-11-01T06:00:00.000Z','2026-11-02T05:59:00.000Z','2026-11-01',{count:7777});
    // Not connected: no WHOOP offset, so the day falls back to UTC and says so.
    let h=harness(db);
    let steps=JSON.parse((await h.call(KIM,'get_dashboard_overview')).body.result.content[0].text).health_connect.daily_steps;
    assert.equal(steps.day_basis,'utc');assert.equal(steps.local_date,'2026-11-02');assert.equal(steps.value,46);
    // Connected: the WHOOP cycle offset sets the member's local day.
    db.sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,scope,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,'2099-01-01T00:00:00Z','read:recovery','x','y','v1','public')").run(KIM);
    h=harness(db,PROD,{whoop:(userId,resource)=>{
      assert.equal(userId,KIM);
      if(resource==='cycles')return {records:[{start:'2026-11-01T19:00:00.000Z',timezone_offset:'-06:00',score_state:'PENDING_SCORE'}]};
      return {records:[]};
    }});
    steps=JSON.parse((await h.call(KIM,'get_dashboard_overview')).body.result.content[0].text).health_connect.daily_steps;
    assert.equal(steps.day_basis,'whoop_timezone_offset');assert.equal(steps.local_date,'2026-11-01');
    assert.equal(steps.value,5146);assert.equal(steps.records_summed,3);assert.equal(steps.ingest,'phone_ingest');
    assert.equal(steps.measured_at,'2026-11-02T03:30:00.000Z');
    assert.match(steps.note,/not added, to avoid counting steps twice/);
    // Another member's records never enter the sum.
    const mom=JSON.parse((await h.call(MOM,'get_dashboard_overview')).body.result.content[0].text).health_connect.daily_steps;
    assert.equal(mom.value,2222);assert.equal(mom.day_basis,'record_local_date');
  }finally{db.sqlite.close();}
});

test('feature flags hide and disable gated member tools; core member tools stay available',async()=>{
  const db=database();try{
    const off={...PROD,LIFE_SCHEDULE_ENABLED:'false',WEB_HEALTH_IMPORT_ENABLED:'false',HEALTH_CONNECT_WEBHOOK_ENABLED:'false',
      FLARE_JOURNAL_ENABLED:'false',ANNOUNCEMENTS_ENABLED:'false',ISSUE_REPORTS_ENABLED:'false'};
    const h=harness(db,off);
    const names=await h.names(MOM);
    for(const t of ['set_life_schedule','get_companion_sync_status','pause_companion_sync','set_flare_consent','list_service_announcements','report_issue'])
      assert.ok(!names.includes(t),t);
    for(const t of ['get_dashboard_overview','get_account_data_summary','get_recovery','get_capabilities'])
      assert.ok(names.includes(t),t);
    assert.equal((await h.call(MOM,'pause_companion_sync',{confirm:COMPANION_PAUSE_CONFIRMATION})).body.error?.code,-32602);
    // Owner tools vanish with their flags too, for the owner as well.
    const ownerNames=await h.names(OWNER);
    assert.ok(![...OWNER_ONLY_TOOLS].some(t=>ownerNames.includes(t)));
  }finally{db.sqlite.close();}
});

test('destructive and consent-changing member tools still need their exact confirmations',async()=>{
  const db=database();try{
    const h=harness(db);
    const bad=[['withdraw_health_connect_import',{}],['withdraw_health_connect_import',{confirm:'yes'}],
      ['pause_companion_sync',{}],['pause_companion_sync',{confirm:'yes'}],
      ['revoke_health_connect_ingest_token',{}],['set_life_schedule',{life_schedule:'fixed'}]];
    for(const [name,args] of bad)
      assert.equal((await h.call(MOM,name,args)).body.error?.message,'Invalid tool arguments',name);
    assert.equal(count(db,'SELECT COUNT(*) n FROM health_connect_records'),3,'nothing deleted');
    const withdrawn=await h.call(MOM,'withdraw_health_connect_import',{confirm:'delete-my-health-connect-records'});
    assert.equal(withdrawn.body.result.isError,undefined);
    assert.equal(count(db,`SELECT COUNT(*) n FROM health_connect_records WHERE user_id='${MOM}'`),0);
    assert.equal(count(db,'SELECT COUNT(*) n FROM health_connect_records'),2,'other members keep their records');
    const after=JSON.parse((await h.call(MOM,'get_account_data_summary')).body.result.content[0].text).categories;
    assert.equal(after.health_connect_records.stored,0);
  }finally{db.sqlite.close();}
});
