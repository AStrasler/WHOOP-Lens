// Sanitized diagnostics and member issue reports. Synthetic members only:
// an owner, an "Amy-like" member and a "Kimberly-like" member.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {connect} from './audit-fixtures.mjs';
import {createStagingRouter} from '../src/router.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
import {ISSUE_CONSENT} from '../src/health-connect-webhook.mjs';
import {capture,sanitizeEvent,classifyToolError,newRequestId,BUCKET_MS,RETENTION_DAYS} from '../src/diagnostics.mjs';
import {sanitizeDescription,SUBMIT_CONFIRM,LIMITS,reportIssue} from '../src/issue-reports.mjs';
import {hostInstructionsFor} from '../src/host-instructions.mjs';
import {FeatureDisabled} from '../src/member-guidance.mjs';

const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const AMYLIKE='0b0b0b0b-0000-4000-8000-00000000000b';
const KIMLIKE='0c0c0c0c-0000-4000-8000-00000000000c';
const OUTSIDER='0e0e0e0e-0000-4000-8000-00000000000e';
const ON={MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',HEALTH_CONNECT_WEBHOOK_ENABLED:'true',
  ISSUE_REPORTS_ENABLED:'true',DIAGNOSTICS_CAPTURE_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
const MIGRATIONS=readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
const sqlOf=f=>readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8');
const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});

async function fixture({upTo=null}={}){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of MIGRATIONS){if(upTo&&f>upTo)break;sqlite.exec(sqlOf(f));}
  for(const id of [OWNER,AMYLIKE,KIMLIKE,OUTSIDER]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,id===OUTSIDER?0:1);
  }
  await connect(sqlite,OWNER,'developer','access-'+OWNER);
  await connect(sqlite,AMYLIKE,'public','access-'+AMYLIKE);
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
async function call(db,userId,name,args={},env=ON,requestId){
  const r=await handleMcpRpc({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:args}},{db,userId,env,requestId},{...transport,modern:false});
  return r;
}
const text=r=>r.result.content[0].text;
const data=r=>JSON.parse(text(r));
const rows=(db,sql='SELECT * FROM diagnostic_events ORDER BY id')=>db.sqlite.prepare(sql).all();
function router(){
  return createStagingRouter({verifyIdentity:async req=>{
    const who=req.headers.get('x-synthetic-member');
    if(!who){const {AccessDenied}=awaitAccess;throw new AccessDenied(401);}
    return who;
  }});
}
const awaitAccess=await import('../src/access-denied.mjs');
async function viaRouter(db,who,name,args,env=ON){
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
  if(who)headers['x-synthetic-member']=who;
  const res=await router()(new Request('https://whooplens.tech/mcp',{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{...env,DB:db});
  return {status:res.status,body:await res.json()};
}
async function webhook(db,token,body){
  const res=await router()(new Request('https://whooplens.tech/api/health-connect/webhook',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)}),{...ON,DB:db});
  return {status:res.status,body:await res.json()};
}
const envelope=extra=>({timestamp:'2026-10-18T21:00:00.000Z',app_version:'1.9.22',...extra});
const HEALTH='4321';

// ------------------------------------------------------------ capture

test('capture stores only allowlisted fields with a correlation id, and folds repeats into one row per window',async()=>{
  const db=await fixture();try{
    const now=Date.parse('2026-10-18T22:00:00Z');
    const logs=[];const original=console.log;console.log=l=>logs.push(l);
    try{
      const rid=newRequestId();
      assert.match(rid,/^req_[0-9a-f]{16}$/);
      for(let i=0;i<3;i++)assert.equal(await capture(ON,db,{category:'whoop_api',subsystem:'whoop_api',code:'whoop_upstream_error',
        outcome:'fail',retryable:true,requestId:rid,userId:AMYLIKE,message:'secret body 4321',token:'hct_x'},{now:now+i}),true);
    }finally{console.log=original;}
    const [row,...rest]=rows(db);
    assert.equal(rest.length,0);
    assert.equal(row.count,3);assert.equal(row.user_key,AMYLIKE);assert.equal(row.request_id.startsWith('req_'),true);
    assert.equal(row.bucket%BUCKET_MS,0);assert.equal(row.retryable,1);assert.equal(row.outcome,'fail');
    assert.ok(!JSON.stringify(row).includes('4321')&&!JSON.stringify(row).includes('hct_'));
    // The console line carries no member id and no extra fields.
    for(const line of logs){assert.ok(!line.includes(AMYLIKE));assert.ok(!line.includes('4321'));}
  }finally{db.close();}
});

test('capture rejects free text, unknown categories and bad ids; never throws without the table or with the flag off',async()=>{
  const now=Date.now(),rid=newRequestId();
  assert.equal(sanitizeEvent({category:'whoop_api',subsystem:'x',code:'Has Spaces',outcome:'fail',requestId:rid}),null);
  assert.equal(sanitizeEvent({category:'nope',subsystem:'x',code:'a',outcome:'fail',requestId:rid}),null);
  assert.equal(sanitizeEvent({category:'auth',subsystem:'x',code:'a',outcome:'maybe',requestId:rid}),null);
  assert.equal(sanitizeEvent({category:'auth',subsystem:'x',code:'a',outcome:'fail',requestId:'Bearer abc'}),null);
  assert.equal(sanitizeEvent({category:'auth',subsystem:'x',code:'a',outcome:'fail',requestId:rid,userId:'not-a-uuid'}).user_key,'');
  const old=await fixture({upTo:'0016_whoop_connection_generations.sql'});
  try{assert.equal(await capture(ON,old,{category:'auth',subsystem:'mcp',code:'unauthenticated',outcome:'fail',requestId:rid},{now}),false);}
  finally{old.close();}
  const db=await fixture();try{
    assert.equal(await capture({...ON,DIAGNOSTICS_CAPTURE_ENABLED:'false'},db,{category:'auth',subsystem:'mcp',code:'x',outcome:'fail',requestId:rid}),false);
    assert.equal(rows(db).length,0);
  }finally{db.close();}
});

test('retention sweep removes events older than the retention window',async()=>{
  const db=await fixture();try{
    const now=Date.parse('2026-10-18T22:00:00Z'),rid=newRequestId();
    await capture(ON,db,{category:'auth',subsystem:'mcp',code:'old_one',outcome:'fail',requestId:rid},{now:now-(RETENTION_DAYS+1)*86400000});
    await capture(ON,db,{category:'auth',subsystem:'mcp',code:'new_one',outcome:'fail',requestId:rid},{now});
    assert.deepEqual(rows(db).map(r=>r.code),['new_one']);
  }finally{db.close();}
});

test('tool errors are classified into fixed codes; messages are never stored',()=>{
  const e=(m,extra={})=>Object.assign(Error(m),extra);
  assert.equal(classifyToolError(e('x',{status:429,memberLimit:true}),'get_sleep').code,'member_budget_exhausted');
  assert.equal(classifyToolError(e('x',{status:429}),'get_sleep').category,'rate_limit');
  assert.equal(classifyToolError(e('WHOOP API request failed',{status:401}),'get_sleep').code,'whoop_token_rejected');
  assert.equal(classifyToolError(e('WHOOP API request failed',{status:502}),'get_sleep').retryable,true);
  assert.equal(classifyToolError(e('Consent required'),'issue_health_connect_ingest_token').category,'consent');
  assert.equal(classifyToolError(e('Import unavailable'),'issue_health_connect_ingest_token').subsystem,'hc_token');
  assert.equal(classifyToolError(new FeatureDisabled('x'),'connect_whoop').kind,'incomplete_setup');
  assert.equal(classifyToolError(e('D1_ERROR: no such table secret_stuff'),'get_capabilities').code,'db_error');
  assert.equal(classifyToolError(e('anything else 4321'),'get_capabilities').code,'tool_failed');
});

test('MCP failures are captured with the router request id and the authenticated member only',async()=>{
  const db=await fixture();try{
    const r=await viaRouter(db,KIMLIKE,'issue_health_connect_ingest_token',{consent:'wrong'});
    assert.equal(r.status,200);assert.equal(r.body.error.message,'Invalid tool arguments');
    const [row]=rows(db);
    assert.equal(row.category,'mcp_validation');assert.equal(row.code,'invalid_arguments');
    assert.equal(row.user_key,KIMLIKE);assert.match(row.request_id,/^req_[0-9a-f]{16}$/);
    const bad=await viaRouter(db,KIMLIKE,'get_capabilities',{user_id:AMYLIKE});
    assert.equal(bad.body.error.message,'Invalid tool arguments');
  }finally{db.close();}
});

test('unauthenticated and non-member requests are captured without a member id and get no tool access',async()=>{
  const db=await fixture();try{
    const anon=await viaRouter(db,null,'report_issue',{category:'other',description:'it broke again'});
    assert.equal(anon.status,401);
    const outsider=await viaRouter(db,OUTSIDER,'report_issue',{category:'other',description:'it broke again',confirm:SUBMIT_CONFIRM});
    assert.equal(outsider.status,403);
    const r=rows(db);
    assert.deepEqual(r.map(x=>[x.category,x.code,x.user_key]),[['auth','unauthenticated',''],['authorization','membership_inactive',OUTSIDER]]);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM issue_reports').get().n,0);
  }finally{db.close();}
});

test('Kimberly-like delivery that stores nothing is captured as partial for her account, with no content',async()=>{
  const db=await fixture();try{
    const issued=data(await call(db,KIMLIKE,'issue_health_connect_ingest_token',{consent:ISSUE_CONSENT}));
    const token=issued.header_value.slice('Bearer '.length);
    const ok=await webhook(db,token,envelope({weight:[{kg:Number(HEALTH)}]}));
    assert.equal(ok.status,200);assert.equal(ok.body.stored,0);
    const bad=await webhook(db,'hct_'+'A'.repeat(43),envelope({}));
    assert.equal(bad.status,401);
    const r=rows(db);
    assert.deepEqual(r.map(x=>[x.subsystem,x.code,x.outcome,x.user_key]),[
      ['hc_webhook','hc_only_unsupported_types','partial',KIMLIKE],
      ['hc_webhook','hc_token_rejected','fail','']]);
    const dump=JSON.stringify(r);
    assert.ok(!dump.includes(HEALTH)&&!dump.includes(token)&&!dump.includes('weight'));
    // Stored records produce a success event for the member.
    const amy=data(await call(db,AMYLIKE,'issue_health_connect_ingest_token',{consent:ISSUE_CONSENT}));
    await webhook(db,amy.header_value.slice(7),envelope({steps:[{count:1200,start_time:'2026-10-17T00:00:00Z',end_time:'2026-10-18T00:00:00Z',metadata:{id:'s1',lastModifiedTime:'2026-10-18T01:00:00Z'}}]}));
    assert.ok(rows(db).some(x=>x.code==='hc_delivery_stored'&&x.outcome==='success'&&x.user_key===AMYLIKE));
    assert.ok(!JSON.stringify(rows(db)).includes('1200'));
  }finally{db.close();}
});

// ------------------------------------------------------------ report_issue

test('report_issue previews first, writes nothing, and states no report exists yet',async()=>{
  const db=await fixture();try{
    const r=data(await call(db,AMYLIKE,'report_issue',{category:'unavailable_data',description:'My sleep is missing since yesterday'}));
    assert.equal(r.submitted,false);assert.equal(r.approval_required,true);
    assert.match(r.next_step,/No report exists yet/);
    assert.ok(!('reference' in r));
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM issue_reports').get().n,0);
  }finally{db.close();}
});

test('approved report is bound to the authenticated member, carries the request id and evidence, and returns a read-back reference',async()=>{
  const db=await fixture();try{
    await capture(ON,db,{category:'whoop_api',subsystem:'whoop_api',code:'whoop_upstream_error',outcome:'fail',retryable:true,requestId:newRequestId(),userId:AMYLIKE});
    await capture(ON,db,{category:'auth',subsystem:'mcp',code:'other_member_event',outcome:'fail',requestId:newRequestId(),userId:KIMLIKE});
    const rid='req_00112233445566aa';
    const r=data(await call(db,AMYLIKE,'report_issue',{category:'backend_failure',description:'Recovery keeps failing to load',confirm:SUBMIT_CONFIRM},ON,rid));
    assert.equal(r.submitted,true);assert.match(r.reference,/^WL-[A-Z0-9]{8}$/);assert.equal(r.duplicate,false);
    const row=db.sqlite.prepare('SELECT * FROM issue_reports').get();
    assert.equal(row.reference,r.reference);assert.equal(row.user_id,AMYLIKE);assert.equal(row.request_id,rid);
    assert.equal(row.severity,'high');assert.equal(row.status,'new');assert.equal(row.subsystems,'whoop_api');
    const evidence=JSON.parse(row.evidence_json);
    assert.deepEqual(evidence.map(e=>e.code),['whoop_upstream_error']);
    assert.ok(!row.evidence_json.includes(KIMLIKE)&&!row.evidence_json.includes('other_member_event'));
  }finally{db.close();}
});

test('a failed write never returns a reference or claims submission',async()=>{
  const db=await fixture();try{
    const broken={...db,batch:async()=>{throw Error('D1 down');}};
    const r=await call(broken,AMYLIKE,'report_issue',{category:'other',description:'Something is wrong here',confirm:SUBMIT_CONFIRM});
    assert.equal(r.result.isError,true);
    assert.match(text(r),/was not submitted and no reference was created/);
    assert.doesNotMatch(text(r),/WL-/);
    // A write that reports success but cannot be read back is also not confirmed.
    const ghost={...db,batch:async()=>[{success:true,meta:{changes:1}},{success:true}]};
    const g=await call(ghost,AMYLIKE,'report_issue',{category:'other',description:'Something is wrong here',confirm:SUBMIT_CONFIRM});
    assert.equal(g.result.isError,true);assert.doesNotMatch(text(g),/WL-/);
    // Without the migration the tool fails closed with the same message.
    const old=await fixture({upTo:'0016_whoop_connection_generations.sql'});
    try{const o=await call(old,AMYLIKE,'report_issue',{category:'other',description:'Something is wrong here',confirm:SUBMIT_CONFIRM});
      assert.equal(o.result.isError,true);assert.match(text(o),/no reference was created/);}finally{old.close();}
  }finally{db.close();}
});

test('duplicates update the same reference; a resolved report that recurs is marked recurring',async()=>{
  const db=await fixture();try{
    const t0=Date.parse('2026-10-18T20:00:00Z'),rid=newRequestId();
    const args={category:'temporary',description:'Sync keeps timing out',confirm:SUBMIT_CONFIRM};
    const a=await reportIssue(db,AMYLIKE,args,{requestId:rid,env:ON,now:t0});
    const b=await reportIssue(db,AMYLIKE,{...args,description:'  sync KEEPS timing   out '},{requestId:rid,env:ON,now:t0+120000});
    assert.equal(b.reference,a.reference);assert.equal(b.duplicate,true);
    assert.equal(db.sqlite.prepare('SELECT occurrences FROM issue_reports').get().occurrences,2);
    db.sqlite.prepare("UPDATE issue_reports SET status='resolved'").run();
    const c=await reportIssue(db,AMYLIKE,args,{requestId:rid,env:ON,now:t0+240000});
    assert.equal(c.reference,a.reference);assert.equal(c.status,'recurring');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM issue_reports').get().n,1);
  }finally{db.close();}
});

test('rate limits: one per minute, a daily cap per member, and a server-wide cap',async()=>{
  const db=await fixture();try{
    const t0=Date.parse('2026-10-18T10:00:00Z'),rid=newRequestId();
    const send=(who,i,now)=>reportIssue(db,who,{category:'other',description:'Problem number '+'abcdefghij'[i]+' happened',confirm:SUBMIT_CONFIRM},{requestId:rid,env:ON,now});
    await send(AMYLIKE,0,t0);
    await assert.rejects(send(AMYLIKE,1,t0+1000),/Too many reports.*no reference was created/);
    for(let i=1;i<LIMITS.perMemberPerDay;i++)await send(AMYLIKE,i,t0+i*61000);
    await assert.rejects(send(AMYLIKE,9,t0+20*61000),/not submitted/);
    // A different member is not blocked by Amy's limit.
    assert.equal((await send(KIMLIKE,0,t0+20*61000)).submitted,true);
    // Server-wide cap: synthetic rows from another account fill the day's quota.
    const at=new Date(t0+21*61000).toISOString();
    const insert=db.sqlite.prepare("INSERT INTO issue_reports(reference,user_id,category,severity,description,dedupe_key,request_id,evidence_json,created_at,updated_at) VALUES(?,?,'other','low','x',?,?,'[]',?,?)");
    const used=db.sqlite.prepare('SELECT COUNT(*) n FROM issue_reports WHERE updated_at>?').get(new Date(t0+30*61000-86400000).toISOString()).n;
    for(let i=used;i<LIMITS.serverPerDay;i++)insert.run('WL-'+i.toString(36).toUpperCase().padStart(8,'A'),OUTSIDER,i.toString(16).padStart(64,'0'),rid,at,at);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM issue_reports WHERE user_id=?").get(OWNER).n,0);
    await assert.rejects(send(OWNER,0,t0+30*61000),/not submitted/);
  }finally{db.close();}
});

test('descriptions are redacted: numbers, links, addresses, ids and credentials never reach storage',()=>{
  const r=sanitizeDescription('HRV 45 and RHR 52bpm on 10/18, email me a@b.co, see https://x.y/z?q=1, token hct_abcdefghijklmnop and Bearer eyJhbGciOi.x.y id 3c6b1aa4-0000-4000-8000-000000000000 key ABCDEFGHIJKLMNOPQRSTUVWX12');
  for(const bad of ['45','52','10/18','a@b.co','https://','hct_','eyJ','3c6b1aa4','ABCDEFGHIJKLMNOPQRSTUVWX'])assert.ok(!r.text.includes(bad),bad);
  assert.deepEqual(r.removed,['credential','email','id','link','number']);
  assert.match(r.text,/HRV \[number\] and RHR \[number\]/);
  assert.ok(sanitizeDescription('x'.repeat(5000)).text.length<=500);
  assert.equal(sanitizeDescription('<script>alert(1)</script>').text.includes('<'),false);
});

test('a too-short or all-redacted description is not submitted',async()=>{
  const db=await fixture();try{
    const r=await call(db,AMYLIKE,'report_issue',{category:'other',description:'45 52 a@b.co',confirm:SUBMIT_CONFIRM});
    assert.equal(r.result.isError,true);assert.match(text(r),/no reference was created/);
  }finally{db.close();}
});

test('member isolation and owner-only oversight',async()=>{
  const db=await fixture();try{
    const rid=newRequestId(),t0=Date.parse('2026-10-18T10:00:00Z');
    const amy=await reportIssue(db,AMYLIKE,{category:'unavailable_data',description:'Amy private wording here',confirm:SUBMIT_CONFIRM},{requestId:rid,env:ON,now:t0});
    // Members do not see or reach owner tools.
    const list=(await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/list'},{db,userId:KIMLIKE,env:ON},{...transport,modern:false})).result.tools.map(t=>t.name);
    assert.ok(list.includes('report_issue'));assert.ok(!list.includes('review_issue_reports'));assert.ok(!list.includes('update_issue_report'));
    for(const [name,args] of [['review_issue_reports',{}],['update_issue_report',{reference:amy.reference,status:'resolved'}]]){
      const r=await call(db,KIMLIKE,name,args);
      assert.equal(r.error.message,'Unknown tool');
    }
    assert.equal(db.sqlite.prepare('SELECT status FROM issue_reports').get().status,'new');
    // The owner sees sanitized reports and server-wide counts, and can set status only.
    const ownerList=(await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/list'},{db,userId:OWNER,env:ON},{...transport,modern:false})).result.tools.map(t=>t.name);
    assert.ok(ownerList.includes('review_issue_reports'));
    const review=data(await call(db,OWNER,'review_issue_reports',{status:'new'}));
    assert.equal(review.counts.new,1);assert.equal(review.reports[0].reference,amy.reference);
    assert.equal(review.reports[0].member_id,AMYLIKE);
    const upd=data(await call(db,OWNER,'update_issue_report',{reference:amy.reference,status:'acknowledged'}));
    assert.equal(upd.updated,true);
    assert.equal(db.sqlite.prepare('SELECT status FROM issue_reports').get().status,'acknowledged');
    const missing=await call(db,OWNER,'update_issue_report',{reference:'WL-ZZZZZZZZ',status:'resolved'});
    assert.equal(missing.result.isError,true);
    // A member cannot report on behalf of someone else: no id argument exists.
    const spoof=await call(db,KIMLIKE,'report_issue',{category:'other',description:'on behalf of Amy',user_id:AMYLIKE,confirm:SUBMIT_CONFIRM});
    assert.equal(spoof.error.message,'Invalid tool arguments');
    // The owner setting alone decides; a developer seat row elsewhere does not.
    const noOwner={...ON};delete noOwner.WHOOP_LENS_DEVELOPER_USER_ID;
    assert.equal((await call(db,OWNER,'review_issue_reports',{},noOwner)).error.message,'Unknown tool');
  }finally{db.close();}
});

test('with the flag off the tools are not listed and cannot be called; guidance appears only with the flag',async()=>{
  const db=await fixture();try{
    const off={...ON,ISSUE_REPORTS_ENABLED:'false'};
    const list=(await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/list'},{db,userId:OWNER,env:off},{...transport,modern:false})).result.tools.map(t=>t.name);
    assert.ok(!list.some(n=>/issue_report/.test(n)));
    assert.equal((await call(db,AMYLIKE,'report_issue',{category:'other',description:'it broke again'},off)).error.message,'Unknown tool');
  }finally{db.close();}
  const offText=hostInstructionsFor({}),onText=hostInstructionsFor({ISSUE_REPORTS_ENABLED:'true'});
  assert.doesNotMatch(offText,/report_issue/);
  assert.match(onText,/only when report_issue returned submitted true/);
  assert.match(onText,/Never invent a reference/);
  for(const t of [offText,onText]){
    assert.match(t,/Never send members to Cloudflare, Supabase, GitHub/);
    assert.match(t,/temporary .*missing consent .*incomplete setup .*unavailable data .*backend failure/);
  }
});

test('member-facing report responses contain no internal detail or health data',async()=>{
  const db=await fixture();try{
    await capture(ON,db,{category:'infrastructure',subsystem:'mcp',code:'db_error',outcome:'fail',requestId:newRequestId(),userId:AMYLIKE});
    const r=await call(db,AMYLIKE,'report_issue',{category:'backend_failure',description:'My HRV of 45 vanished',confirm:SUBMIT_CONFIRM});
    const out=text(r);
    assert.ok(!out.includes('45')&&!out.includes('db_error')&&!out.includes('req_')&&!out.includes(AMYLIKE));
    assert.match(data(r).message,/^Report WL-[A-Z0-9]{8} was saved/);
  }finally{db.close();}
});

// ------------------------------------------------------------ migration

test('0017 applies after 0001-0016, rolls back and re-applies; existing rows untouched',async()=>{
  assert.equal(MIGRATIONS.at(-1),'0017_member_diagnostics.sql');
  const sqlite=new DatabaseSync(':memory:');
  try{
    sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    for(const f of MIGRATIONS.slice(0,-1)){sqlite.exec(sqlOf(f));sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(f);}
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(AMYLIKE,AMYLIKE);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(AMYLIKE);
    sqlite.prepare("INSERT INTO health_import_consent(user_id,purpose,granted_at) VALUES(?,'health_connect_file','2026-10-01')").run(AMYLIKE);
    const objects=()=>JSON.stringify(sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('diagnostic_events','issue_reports') ORDER BY name").all());
    const data=()=>JSON.stringify(['identity_links','whoop_members','health_import_consent'].map(t=>sqlite.prepare('SELECT * FROM '+t).all()));
    const before=[objects(),data()];
    const up=sqlOf('0017_member_diagnostics.sql');
    assert.doesNotMatch(up,/^\s*(UPDATE|DELETE|ALTER|DROP)\b/m);
    sqlite.exec(up);sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run('0017_member_diagnostics.sql');
    sqlite.exec(up); // idempotent
    assert.deepEqual([objects(),data()],before);
    const down=readFileSync(new URL('../migration/rollback/0017_member_diagnostics.down.sql',import.meta.url),'utf8');
    assert.deepEqual(down.match(/DROP TABLE IF EXISTS \w+/g),['DROP TABLE IF EXISTS issue_reports','DROP TABLE IF EXISTS diagnostic_events']);
    sqlite.exec(down);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('diagnostic_events','issue_reports')").get().n,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM d1_migrations WHERE name='0017_member_diagnostics.sql'").get().n,0);
    assert.deepEqual([objects(),data()],before);
    sqlite.exec(up);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('diagnostic_events','issue_reports')").get().n,2);
    // Constraints reject free text in code fields.
    assert.throws(()=>sqlite.prepare("INSERT INTO diagnostic_events(user_key,category,subsystem,code,outcome,retryable,bucket,first_at,last_at,request_id) VALUES('','auth','mcp','Free Text 45','fail',0,0,'a','a','req_0011223344556677')").run());
  }finally{sqlite.close();}
});
