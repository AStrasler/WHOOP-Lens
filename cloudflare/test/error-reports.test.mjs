import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {runErrorReportTool,errorReportArguments} from '../src/error-reports.mjs';
import {ReportNotSubmitted,reviewIssueReports} from '../src/issue-reports.mjs';
import {handleMcpRpc} from '../src/mcp.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW=Date.parse('2026-10-23T12:00:00Z');
const env={ISSUE_REPORTS_ENABLED:'true',WHOOP_LENS_DEVELOPER_USER_ID:A};
const diagnostics={code:'reconnect_loop',stage:'oauth',operation:'oauth_token',http_status:401,occurred_at:'2026-10-23T11:59:00.000Z'};

test('non-owners cannot discover or directly call get_reportable_links',async()=>{
  const f=fixture();try{
    const rpc=(method,params,userId=B,customEnv=env)=>handleMcpRpc({jsonrpc:'2.0',id:1,method,params},
      {db:f.db,userId,env:customEnv},{modern:false});
    const listed=await rpc('tools/list',{});
    assert.equal(listed.result.tools.some(t=>t.name==='get_reportable_links'),false);
    assert.equal(listed.result.tools.some(t=>t.name==='report_error'),true);
    const denied=await rpc('tools/call',{name:'get_reportable_links',arguments:{}});
    assert.equal(denied.error.code,-32602);
    const owner=await rpc('tools/call',{name:'get_reportable_links',arguments:{}},A);
    assert.equal(owner.result.isError,undefined);
    assert.equal(JSON.parse(owner.result.content[0].text).links.length,1);
    const missingOwner=await rpc('tools/list',{},A,{ISSUE_REPORTS_ENABLED:'true'});
    assert.equal(missingOwner.result.tools.some(t=>t.name==='get_reportable_links'),false);
  }finally{f.close();}
});

test('the backend rejects a non-owner link lookup before touching account storage',async()=>{
  const db={prepare(){throw Error('Storage must not be queried');}};
  await assert.rejects(runErrorReportTool('get_reportable_links',{}, {db,userId:B,env}),ReportNotSubmitted);
});

test('members retain their own report_error path and free-text report tool',async()=>{
  const f=fixture();try{
    // Fixture handle is obtained under a separate synthetic owner config,
    // then used with the real test config where B is an ordinary member.
    const link_id=(await f.run('get_reportable_links',{},B,{env:{...env,WHOOP_LENS_DEVELOPER_USER_ID:B}})).links[0].link_id;
    const result=await f.run('report_error',{link_id,diagnostics},B);
    assert.equal(result.approval_required,true);
    const list=await handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/list'}, {db:f.db,userId:B,env},{modern:true});
    assert.equal(list.result.tools.some(t=>t.name==='get_reportable_links'),false);
    assert.equal(list.result.tools.some(t=>t.name==='report_issue'),true);
    assert.equal(list.result.tools.some(t=>t.name==='report_error'),true);
  }finally{f.close();}
});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of ['0001_initial.sql','0016_whoop_connection_generations.sql','0017_member_diagnostics.sql','0018_issue_report_reference_check.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
    sqlite.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,'2026-10-24T00:00:00Z',?,?,'v1','public')").run(id,'encrypted-access-'+id,'encrypted-refresh-'+id);
    sqlite.prepare('INSERT INTO whoop_connection_generations(user_id,generation) VALUES(?,1)').run(id);
  }
  const db=d1Database(sqlite);
  const run=(name,args={},userId=A,extra={})=>runErrorReportTool(name,args,{db,userId,env,requestId:'req_test_1234',now:NOW,...extra});
  return {sqlite,db,run,close:()=>sqlite.close(),snapshot:()=>JSON.stringify(sqlite.prepare('SELECT * FROM whoop_connections ORDER BY user_id').all())};
}
test('eligible link handles are own-account, do not expose IDs and change on reconnect',async()=>{
  const f=fixture();try{
    const own=(await f.run('get_reportable_links')).links[0];
    const other=(await f.run('get_reportable_links',{},B,{env:{...env,WHOOP_LENS_DEVELOPER_USER_ID:B}})).links[0];
    assert.notEqual(own.link_id,other.link_id);assert.ok(!own.link_id.includes(A));
    f.sqlite.prepare('UPDATE whoop_connection_generations SET generation=generation+1 WHERE user_id=?').run(A);
    assert.notEqual((await f.run('get_reportable_links')).links[0].link_id,own.link_id);
    await assert.rejects(f.run('report_error',{link_id:own.link_id,diagnostics}),e=>e.reason==='invalid_link');
  }finally{f.close();}
});
test('structured reports preview exact diagnostics, save to owner queue once and preserve WHOOP credentials',async()=>{
  const f=fixture();try{
    const before=f.snapshot(),link_id=(await f.run('get_reportable_links')).links[0].link_id;
    const args={link_id,diagnostics};
    const preview=await f.run('report_error',args);
    assert.equal(preview.submitted,false);assert.deepEqual(preview.diagnostics,diagnostics);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_reports').get().n,0);
    const saved=await f.run('report_error',{...args,approved:true});
    assert.equal(saved.submitted,true);assert.match(saved.reference,/^WL-[A-Z0-9]{8}$/);
    assert.equal(saved.connection_unchanged,true);assert.equal(f.snapshot(),before);
    const reviewed=await reviewIssueReports(f.db,A,{}, {env,now:NOW});
    const record=reviewed.reports[0];
    assert.deepEqual(record.evidence[0].diagnostics,diagnostics);
    assert.equal(record.evidence[0].source,'client_reported');assert.equal(record.evidence[0].link_id,link_id);
    await assert.rejects(f.run('report_error',{...args,approved:true}),e=>e.reason==='approval_invalid');
    assert.equal(f.snapshot(),before);
  }finally{f.close();}
});
test('a foreign, stale, disconnected or inactive link never creates an approval or report',async()=>{
  for(const kind of ['foreign','random','disconnected','inactive']){
    const f=fixture();try{
      let link_id=(await f.run('get_reportable_links')).links[0].link_id;
      if(kind==='foreign')link_id=(await f.run('get_reportable_links',{},B,{env:{...env,WHOOP_LENS_DEVELOPER_USER_ID:B}})).links[0].link_id;
      if(kind==='random')link_id='lnk_'+'0'.repeat(64);
      if(kind==='disconnected')f.sqlite.prepare('DELETE FROM whoop_connections WHERE user_id=?').run(A);
      if(kind==='inactive')f.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
      await assert.rejects(f.run('report_error',{link_id,diagnostics}),e=>e.reason==='invalid_link'&&e.message.includes('eligible linked account'));
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_report_approvals').get().n,0);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_reports').get().n,0);
    }finally{f.close();}
  }
});
test('approval binds every diagnostic field and link, independent of JSON key ordering',async()=>{
  const f=fixture();try{
    const link_id=(await f.run('get_reportable_links')).links[0].link_id;
    await f.run('report_error',{link_id,diagnostics});
    await assert.rejects(f.run('report_error',{link_id,diagnostics:{...diagnostics,http_status:403},approved:true}),e=>e.reason==='approval_invalid');
    const reordered=Object.fromEntries(Object.entries(diagnostics).reverse());
    assert.equal((await f.run('report_error',{link_id,diagnostics:reordered,approved:true})).submitted,true);
  }finally{f.close();}
});
test('structured diagnostics reject arbitrary content, health values, timestamps and another member’s request IDs',async()=>{
  const f=fixture();try{
    const link_id=(await f.run('get_reportable_links')).links[0].link_id;
    for(const diagnostic of [{...diagnostics,body:'Bearer secret'},{...diagnostics,hrv:26.42},
      {...diagnostics,code:'private_secret'}, {...diagnostics,stage:'https://secret.invalid'},
      {...diagnostics,operation:'run_command'},{...diagnostics,http_status:67},
      {...diagnostics,occurred_at:'2026-02-30T12:00:00.000Z'}])
      assert.equal(errorReportArguments('report_error',{link_id,diagnostics:diagnostic}),null);
    assert.equal(errorReportArguments('report_error',{link_id,diagnostics,user_id:B}),null);
    await assert.rejects(f.run('report_error',{link_id,diagnostics:{...diagnostics,occurred_at:'2026-10-20T12:00:00.000Z'}}),ReportNotSubmitted);
    f.sqlite.prepare("INSERT INTO diagnostic_events(user_key,category,subsystem,code,outcome,retryable,bucket,count,first_at,last_at,request_id) VALUES(?,'auth','mcp','unauthenticated','fail',0,0,1,?,?,'req_other_1234')")
      .run(B,new Date(NOW).toISOString(),new Date(NOW).toISOString());
    await assert.rejects(f.run('report_error',{link_id,diagnostics:{...diagnostics,request_id:'req_other_1234'}}),ReportNotSubmitted);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_reports').get().n,0);
  }finally{f.close();}
});
test('atomic submission rechecks live membership and connection generation',async()=>{
  const f=fixture();try{
    const link_id=(await f.run('get_reportable_links')).links[0].link_id;
    await f.run('report_error',{link_id,diagnostics});
    const originalBatch=f.db.batch;
    f.db.batch=async statements=>{
      f.sqlite.prepare('UPDATE whoop_connection_generations SET generation=generation+1 WHERE user_id=?').run(A);
      return originalBatch(statements);
    };
    await assert.rejects(f.run('report_error',{link_id,diagnostics,approved:true}));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_reports').get().n,0);
  }finally{f.close();}
});
test('report_error is exposed through the same MCP feature flag and accepts no caller-selected identity',async()=>{
  const f=fixture();try{
    const rpc=(name,args={},customEnv=env)=>handleMcpRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},
      {db:f.db,userId:A,env:customEnv},{modern:false});
    const links=JSON.parse((await rpc('get_reportable_links')).result.content[0].text);
    const link_id=links.links[0].link_id;
    assert.equal((await rpc('report_error',{link_id,diagnostics,user_id:B})).error.code,-32602);
    assert.equal((await rpc('report_error',{link_id,diagnostics},{ISSUE_REPORTS_ENABLED:'false'})).error.code,-32602);
    const result=await rpc('report_error',{link_id,diagnostics});
    assert.equal(result.result.isError,undefined);
    assert.equal(JSON.parse(result.result.content[0].text).approval_required,true);
  }finally{f.close();}
});
