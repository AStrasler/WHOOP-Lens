// Owner-only service announcements. Synthetic members only. No health values are
// required; one recovery row exists so a response can be checked for leaks.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
import {AccessDenied} from '../src/access-denied.mjs';
import {hostInstructionsFor} from '../src/host-instructions.mjs';
import {featureStates} from '../src/member-guidance.mjs';
import {listMemberAnnouncements,createAnnouncement,updateAnnouncement,manageAnnouncements,AnnouncementRejected} from '../src/announcements.mjs';

const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const AMY='0b0b0b0b-0000-4000-8000-00000000000b';
const KIM='0c0c0c0c-0000-4000-8000-00000000000c';
const OUTSIDER='0e0e0e0e-0000-4000-8000-00000000000e';
const NOW=Date.parse('2026-10-27T15:00:00.000Z');
const PAST='2026-10-27T14:00:00.000Z';
const FUTURE='2026-10-28T02:00:00.000Z';
const LATER='2026-10-28T06:00:00.000Z';
const ON={MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',
  ANNOUNCEMENTS_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
const OFF={...ON,ANNOUNCEMENTS_ENABLED:'false'};
const UUID_RE=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MEMBER_KEYS=['body','expires_at','id','kind','starts_at','title'];
const MIGRATIONS=readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
const sqlOf=f=>readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8');
const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});

function database({migrate=true}={}){
  const sqlite=new DatabaseSync(':memory:');
  const files=migrate?MIGRATIONS:['0001_initial.sql'];
  for(const f of files)sqlite.exec(sqlOf(f));
  for(const [id,active] of [[OWNER,1],[AMY,1],[KIM,1],[OUTSIDER,0]]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,active);
  }
  sqlite.prepare("INSERT INTO whoop_recovery(user_id,whoop_id,date,score,hrv,resting_heart_rate,raw_json) VALUES(?,'synthetic','2026-10-20',87.5,54,48,'{\"score\":87.5}')").run(AMY);
  const db={sqlite,...d1Database(sqlite),close(){sqlite.close();}};
  return db;
}
const notices=db=>db.sqlite.prepare('SELECT COUNT(*) n FROM service_announcements').get().n;
const recovery=db=>db.sqlite.prepare('SELECT score,hrv,raw_json FROM whoop_recovery').all();
function notice(extra={}){
  return {kind:'maintenance',title:'Maintenance tonight',body:'WhoopLens will be briefly unavailable.',
    audience:'all',starts_at:PAST,expires_at:LATER,status:'active',...extra};
}
function router(){
  return createStagingRouter({verifyIdentity:async request=>{
    const who=request.headers.get('x-synthetic-member');
    if(!who)throw new AccessDenied(401);
    return who;
  }});
}
async function http(db,who,method,path,payload,env=ON){
  const headers={accept:'application/json'};
  if(who)headers['x-synthetic-member']=who;
  if(payload!==undefined)headers['content-type']='application/json';
  const response=await router()(new Request('https://whooplens.tech'+path,{method,headers,
    body:payload===undefined?undefined:JSON.stringify(payload)}),{...env,DB:db});
  const text=await response.text();
  return {status:response.status,text,body:text?JSON.parse(text):null};
}
async function mcp(db,who,method,params,env=ON){
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
  if(who)headers['x-synthetic-member']=who;
  const response=await router()(new Request('https://whooplens.tech/mcp',{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:3,method,params})}),{...env,DB:db});
  return {status:response.status,body:await response.json()};
}
async function call(db,userId,name,args={},env=ON){
  return handleMcpRpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name,arguments:args}},
    {db,userId,env},{...transport,modern:false});
}
const toolText=result=>JSON.parse(result.result.content[0].text);
function assertPrivateMemberView(payload){
  const text=JSON.stringify(payload);
  assert.doesNotMatch(text,UUID_RE);
  assert.doesNotMatch(text,/87\.5|heart|hrv|score|member@|@example|raw_json|user_id|member_ids/i);
  for(const item of payload.announcements??[])assert.deepEqual(Object.keys(item).sort(),MEMBER_KEYS);
}

test('flag off returns an empty inbox and refuses management without reading notices',async()=>{
  const db=database();
  try{
    const created=await createAnnouncement(db,OWNER,notice(),{env:ON,now:NOW});
    const boom={prepare(){throw new Error('announcement query');},batch(){throw new Error('announcement write');}};
    assert.deepEqual(await listMemberAnnouncements(boom,AMY,{env:OFF,now:NOW}),{enabled:false,announcements:[]});
    await assert.rejects(()=>createAnnouncement(boom,OWNER,notice(),{env:OFF,now:NOW}),AnnouncementRejected);
    const listed=await http(db,AMY,'GET','/v1/announcements',undefined,OFF);
    assert.equal(listed.status,200);
    assert.deepEqual(listed.body,{enabled:false,announcements:[]});
    assert.doesNotMatch(listed.text,new RegExp(created.title));
    const denied=await http(db,OWNER,'POST','/v1/announcements',notice(),OFF);
    assert.equal(denied.status,403);
    assert.match(denied.body.error,/turned off/);
    assert.equal(notices(db),1);
    const tools=await mcp(db,OWNER,'tools/list',{},OFF);
    assert.equal(tools.body.result.tools.some(t=>String(t.name).includes('announcement')),false);
  }finally{db.close();}
});

test('owner and non-owner are isolated on the HTTP API and on MCP',async()=>{
  const db=database();
  try{
    const before=recovery(db);
    const created=await http(db,OWNER,'POST','/v1/announcements',notice({starts_at:new Date(Date.now()-3600_000).toISOString(),expires_at:new Date(Date.now()+3600_000).toISOString()}));
    assert.equal(created.status,201,created.text);
    const id=created.body.id;
    const memberTools=await mcp(db,AMY,'tools/list',{});
    const names=memberTools.body.result.tools.map(t=>t.name);
    assert.ok(names.includes('list_service_announcements'));
    for(const name of ['create_service_announcement','update_service_announcement','manage_service_announcements'])
      assert.equal(names.includes(name),false,name);
    const ownerTools=await mcp(db,OWNER,'tools/list',{});
    for(const name of ['create_service_announcement','update_service_announcement','manage_service_announcements','list_service_announcements'])
      assert.ok(ownerTools.body.result.tools.some(t=>t.name===name),name);
    const direct=await mcp(db,AMY,'tools/call',{name:'create_service_announcement',arguments:notice()});
    assert.equal(direct.body.error.message,'Unknown tool');
    assert.doesNotMatch(JSON.stringify(direct.body),/Maintenance tonight/);
    const manage=await http(db,AMY,'GET','/v1/announcements/manage');
    assert.equal(manage.status,403);
    assert.equal(manage.body.error,'Not allowed.');
    assert.doesNotMatch(manage.text,/Maintenance tonight|member_ids/);
    const update=await http(db,AMY,'POST','/v1/announcements/update',{id,action:'expire'});
    assert.equal(update.status,403);
    const memberCreate=await http(db,AMY,'POST','/v1/announcements',notice({title:'Member broadcast',body:'This must not be stored.'}));
    assert.equal(memberCreate.status,403);
    assert.doesNotMatch(memberCreate.text,/Member broadcast/);
    assert.equal(notices(db),1);
    const viaMcp=await call(db,OWNER,'create_service_announcement',notice({title:'MCP notice',body:'Created through the owner tool.',
      starts_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+3600_000).toISOString()}));
    assert.equal(viaMcp.error,undefined);
    assert.equal(toolText(viaMcp).title,'MCP notice');
    assert.deepEqual(toolText(viaMcp).member_ids,[]);
    const expired=await call(db,OWNER,'update_service_announcement',{id:viaMcp.result?toolText(viaMcp).id:id,action:'expire'});
    assert.equal(toolText(expired).status,'expired');
    const hidden=await http(db,AMY,'GET','/v1/announcements');
    assert.equal(hidden.body.announcements.some(item=>item.title==='MCP notice'),false);
    assert.equal(notices(db),2);
    const ownerList=await call(db,OWNER,'manage_service_announcements');
    assert.equal(toolText(ownerList).announcements.length,2);
    const memberCall=await call(db,KIM,'manage_service_announcements');
    assert.equal(memberCall.error.message,'Unknown tool');
    const caps=toolText(await call(db,AMY,'get_capabilities',{}));
    assert.equal(caps.tool_permissions.some(p=>p.tool==='create_service_announcement'),false);
    const ownerCaps=toolText(await call(db,OWNER,'get_capabilities',{}));
    assert.equal(ownerCaps.tool_permissions.find(p=>p.tool==='create_service_announcement').owner_only,true);
    assert.equal(ownerCaps.tool_permissions.find(p=>p.tool==='list_service_announcements').owner_only,false);
    assert.deepEqual(recovery(db),before);
    assert.equal((await http(db,null,'GET','/v1/announcements')).status,401);
    assert.equal((await http(db,null,'POST','/v1/announcements',notice())).status,401);
    assert.equal((await http(db,OUTSIDER,'GET','/v1/announcements')).status,403);
    assert.equal((await mcp(db,null,'tools/call',{name:'create_service_announcement',arguments:notice()})).status,401);
  }finally{db.close();}
});

test('targeting, schedule, expiry and cancellation stay on the server',async()=>{
  const db=database();
  try{
    const all=await createAnnouncement(db,OWNER,notice(),{env:ON,now:NOW});
    const amy=await createAnnouncement(db,OWNER,notice({title:'For one member',body:'This notice is only for one seat.',audience:'members',member_ids:[AMY]}),{env:ON,now:NOW});
    const upcoming=await createAnnouncement(db,OWNER,notice({title:'Tomorrow window',body:'Scheduled work.',starts_at:FUTURE,expires_at:LATER,status:'scheduled'}),{env:ON,now:NOW});
    const draft=await createAnnouncement(db,OWNER,notice({title:'Still a draft',body:'Not published.',status:'draft'}),{env:ON,now:NOW});
    const ended=await createAnnouncement(db,OWNER,notice({title:'Already over',body:'This window ended.'}),{env:ON,now:NOW});
    await updateAnnouncement(db,OWNER,{id:ended.id,action:'expire'},{env:ON,now:NOW});
    const amyView=await listMemberAnnouncements(db,AMY,{env:ON,now:NOW});
    const kimView=await listMemberAnnouncements(db,KIM,{env:ON,now:NOW});
    assert.deepEqual(amyView.announcements.map(item=>item.id).sort(),[all.id,amy.id].sort());
    assert.deepEqual(kimView.announcements.map(item=>item.id),[all.id]);
    assertPrivateMemberView(amyView);
    assertPrivateMemberView(kimView);
    const atStart=await listMemberAnnouncements(db,AMY,{env:ON,now:Date.parse(PAST)});
    assert.ok(atStart.announcements.some(item=>item.id===all.id));
    const atExpiry=await listMemberAnnouncements(db,AMY,{env:ON,now:Date.parse(LATER)});
    assert.equal(atExpiry.announcements.some(item=>item.id===all.id),false);
    assert.equal(amyView.announcements.some(item=>item.id===upcoming.id||item.id===draft.id||item.id===ended.id),false);
    await updateAnnouncement(db,OWNER,{id:amy.id,action:'save',audience:'members',member_ids:[KIM]},{env:ON,now:NOW});
    const after=await listMemberAnnouncements(db,AMY,{env:ON,now:NOW});
    const kimAfter=await listMemberAnnouncements(db,KIM,{env:ON,now:NOW});
    assert.equal(after.announcements.some(item=>item.id===amy.id),false);
    assert.ok(kimAfter.announcements.some(item=>item.title==='For one member'));
    await updateAnnouncement(db,OWNER,{id:upcoming.id,action:'schedule',starts_at:FUTURE},{env:ON,now:NOW});
    assert.equal((await listMemberAnnouncements(db,AMY,{env:ON,now:NOW})).announcements.some(item=>item.id===upcoming.id),false);
    assert.ok((await listMemberAnnouncements(db,AMY,{env:ON,now:Date.parse(FUTURE)})).announcements.some(item=>item.id===upcoming.id));
    await updateAnnouncement(db,OWNER,{id:draft.id,action:'publish'},{env:ON,now:NOW});
    assert.ok((await listMemberAnnouncements(db,KIM,{env:ON,now:NOW})).announcements.some(item=>item.id===draft.id));
    await updateAnnouncement(db,OWNER,{id:all.id,action:'expire'},{env:ON,now:NOW});
    await updateAnnouncement(db,OWNER,{id:draft.id,action:'cancel'},{env:ON,now:NOW});
    const gone=await listMemberAnnouncements(db,KIM,{env:ON,now:NOW});
    assert.equal(gone.announcements.some(item=>item.id===all.id||item.id===draft.id),false);
    const managed=await manageAnnouncements(db,OWNER,{env:ON});
    const targeted=managed.announcements.find(item=>item.id===amy.id);
    assert.deepEqual(targeted.member_ids,[KIM]);
    assert.equal(managed.announcements.find(item=>item.id===all.id).status,'expired');
    assert.doesNotMatch(JSON.stringify(managed),/87\.5|member@|heart rate/i);
    await assert.rejects(()=>createAnnouncement(db,AMY,notice(),{env:ON,now:NOW}),error=>error.reason==='forbidden');
  }finally{db.close();}
});

test('retired notices free the cap, and withdrawal still works after a target leaves',async()=>{
  const db=database();
  try{
    const kept=await createAnnouncement(db,OWNER,notice({title:'Keep this window',body:'This one stays outstanding.'}),{env:ON,now:NOW});
    const first=[];
    for(let i=0;i<49;i++)first.push(await createAnnouncement(db,OWNER,notice({title:`Window ${i}`,body:'A maintenance window.'}),{env:ON,now:NOW}));
    await assert.rejects(()=>createAnnouncement(db,OWNER,notice({title:'One too many',body:'This must wait.'}),{env:ON,now:NOW}),
      error=>error instanceof AnnouncementRejected&&error.reason==='invalid');
    for(const row of first)await updateAnnouncement(db,OWNER,{id:row.id,action:'expire'},{env:ON,now:NOW});
    const second=[];
    for(let i=0;i<49;i++)second.push(await createAnnouncement(db,OWNER,notice({title:`Later window ${i}`,body:'Another maintenance window.'}),{env:ON,now:NOW}));
    for(const row of second)await updateAnnouncement(db,OWNER,{id:row.id,action:'cancel'},{env:ON,now:NOW});
    const managed=await manageAnnouncements(db,OWNER,{env:ON});
    assert.ok(managed.announcements.some(item=>item.id===kept.id&&item.status==='active'));
    const again=await createAnnouncement(db,OWNER,notice({title:'After retirement',body:'Retired rows do not block this.'}),{env:ON,now:NOW});
    assert.equal(again.status,'active');
    const seat=await createAnnouncement(db,OWNER,notice({title:'For one seat',body:'Only one member should see this.',audience:'members',member_ids:[AMY]}),{env:ON,now:NOW});
    const draft=await createAnnouncement(db,OWNER,notice({title:'Draft for one seat',body:'Not published yet.',audience:'members',member_ids:[AMY],status:'draft'}),{env:ON,now:NOW});
    db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(AMY);
    const expired=await updateAnnouncement(db,OWNER,{id:seat.id,action:'expire'},{env:ON,now:NOW});
    assert.equal(expired.status,'expired');
    const edited=await updateAnnouncement(db,OWNER,{id:draft.id,action:'save',title:'Draft still editable'},{env:ON,now:NOW});
    assert.equal(edited.title,'Draft still editable');
    const published=await updateAnnouncement(db,OWNER,{id:draft.id,action:'publish'},{env:ON,now:NOW});
    assert.equal(published.status,'active');
    const cancelled=await updateAnnouncement(db,OWNER,{id:draft.id,action:'cancel'},{env:ON,now:NOW});
    assert.equal(cancelled.status,'cancelled');
    await assert.rejects(()=>createAnnouncement(db,OWNER,notice({title:'Inactive seat',body:'This must not be stored.',audience:'members',member_ids:[AMY]}),{env:ON,now:NOW}),
      error=>error instanceof AnnouncementRejected&&error.reason==='invalid');
    await assert.rejects(()=>updateAnnouncement(db,OWNER,{id:kept.id,action:'save',audience:'members',member_ids:[AMY]},{env:ON,now:NOW}),
      error=>error instanceof AnnouncementRejected&&error.reason==='invalid');
    assert.equal((await listMemberAnnouncements(db,KIM,{env:ON,now:NOW})).announcements.some(item=>item.id===seat.id||item.id===draft.id),false);
    assert.equal(notices(db),1+49+49+1+2);
  }finally{db.close();}
});

test('malformed notices and private text are refused and not stored or echoed',async()=>{
  const db=database();
  try{
    const leaked='Recovery score is 87.5 for member@example.com and heart rate 54';
    const cases=[
      notice({kind:'broadcast'}),
      notice({title:''}),
      notice({body:leaked}),
      notice({title:'See member@example.com'}),
      notice({body:'Account 0b0b0b0b-0000-4000-8000-00000000000b needs a reset.'}),
      notice({body:'Details at https://secret.example/internal'}),
      notice({audience:'members',member_ids:['member@example.com']}),
      notice({audience:'members',member_ids:[OUTSIDER]}),
      notice({audience:'members',member_ids:['0d0d0d0d-0000-4000-8000-00000000000d']}),
      notice({audience:'all',member_ids:[AMY]}),
      notice({starts_at:'tomorrow'}),
      notice({status:'active',starts_at:FUTURE}),
      notice({extra:'nope'}),
      notice({status:'expired'})
    ];
    for(const input of cases){
      const response=await http(db,OWNER,'POST','/v1/announcements',input);
      assert.equal(response.status,400,JSON.stringify(input));
      assert.equal(response.body.error,'That announcement could not be saved.');
      assert.doesNotMatch(response.text,/87\.5|member@|0b0b0b0b|secret\.example|heart/i);
    }
    assert.equal(notices(db),0);
    assert.equal(recovery(db)[0].score,87.5);
    const missing=await http(database({migrate:false}),AMY,'GET','/v1/announcements');
    assert.equal(missing.status,503);
    assert.doesNotMatch(missing.text,/sqlite|no such table|service_announcements/i);
  }finally{db.close();}
});

test('migration 0020 is additive and rolls back without touching members',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  try{
    sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    for(const f of MIGRATIONS.filter(f=>f<'0020'))sqlite.exec(sqlOf(f));
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(AMY,AMY);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(AMY);
    const before=JSON.stringify(sqlite.prepare('SELECT * FROM whoop_members').all());
    const up=sqlOf('0020_service_announcements.sql');
    assert.doesNotMatch(up,/^\s*(UPDATE|DELETE|ALTER|DROP)\b/m);
    sqlite.exec(up);
    sqlite.exec(up);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('service_announcements','service_announcement_targets')").get().n,2);
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM whoop_members').all()),before);
    const down=readFileSync(new URL('../migration/rollback/0020_service_announcements.down.sql',import.meta.url),'utf8');
    sqlite.exec(down);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('service_announcements','service_announcement_targets')").get().n,0);
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM whoop_members').all()),before);
    sqlite.exec(up);
  }finally{sqlite.close();}
});

test('instructions and the default flag stay off, including both Worker configs',()=>{
  assert.equal(hostInstructionsFor({ANNOUNCEMENTS_ENABLED:'false'}),hostInstructionsFor({}));
  assert.doesNotMatch(hostInstructionsFor({}),/list_service_announcements/);
  const on=hostInstructionsFor({ANNOUNCEMENTS_ENABLED:'true'});
  assert.match(on,/list_service_announcements/);
  assert.match(on,/cannot push an unsolicited chat message/);
  assert.match(on,/Push notification delivery is not part of this feature/);
  assert.equal(featureStates({}).find(f=>f.id==='service_announcements').state,'disabled');
  assert.equal(featureStates({ANNOUNCEMENTS_ENABLED:'true'}).find(f=>f.id==='service_announcements').state,'enabled');
  assert.equal(featureStates({ANNOUNCEMENTS_ENABLED:'TRUE'}).find(f=>f.id==='service_announcements').state,'disabled');
  for(const path of ['../wrangler.jsonc','../oauth/resource/wrangler.jsonc']){
    const text=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.match(text,/"ANNOUNCEMENTS_ENABLED"\s*:\s*"false"/);
  }
});
