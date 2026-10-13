import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createStagingRouter} from '../src/router.mjs';
import {d1Prepare,d1Database} from './d1-sqlite.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now=Date.parse('2026-10-11T12:00:00Z');
const file={
  schema_version:2,source:'health_connect',exported_at:'2026-10-11T11:00:00Z',
  user_id:B,
  records:[{
    metric:'steps_daily',record_key:'daily:2026-10-10:local',
    observed_at:'2026-10-10T05:00:00Z',ended_at:'2026-10-11T05:00:00Z',
    local_date:'2026-10-10',origin_package:'com.samsung.health',
    unit:'steps',payload:{count:4321}
  }]
};
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0001_initial.sql','0004_medical_context_review.sql','0006_health_import_consent.sql','0007_health_connect_ingest.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
  }
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
function routeFor(db){
  return createStagingRouter({verifyIdentity:async()=>A});
}
function env(db,enabled=true){
  return {DB:db,MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',
    WEB_HEALTH_IMPORT_ENABLED:enabled?'true':'false'};
}
test('file import stores only the caller rows and refuses FHIR, missing consent, and a disabled flag',async()=>{
  const db=fixture();try{
    const route=routeFor(db);
    const post=(body,enabled=true)=>route(new Request('https://whooplens.tech/v1/health-connect/import',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
    }),env(db,enabled));
    const blocked=await post({consent:'store-health-connect-file',file},false);
    assert.equal(blocked.status,503);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,0);
    const denied=await (await post({file},true)).json();
    assert.equal(denied.error,'Consent required');
    const fhir=await (await post({consent:'store-health-connect-file',file:{resourceType:'Bundle',entry:[]}},true)).json();
    assert.match(fhir.error,/FHIR bundles stay a local preview/);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,0);
    const saved=await (await post({consent:'store-health-connect-file',file},true)).json();
    assert.equal(saved.stored,1);
    assert.equal(saved.transport,'web_file_import');
    assert.equal(saved.live_sync,undefined);
    const row=db.sqlite.prepare('SELECT user_id,metric,payload_json FROM health_connect_records').get();
    assert.equal(row.user_id,A);
    assert.equal(row.metric,'steps_daily');
    assert.equal(JSON.parse(row.payload_json).count,4321);
    const status=await (await route(new Request('https://whooplens.tech/v1/health-connect/status'),env(db))).json();
    assert.deepEqual(status,{stored_records:1,consent:'granted',source:'health_connect',transport:'web_file_import',live_sync:false});
    const other=createStagingRouter({verifyIdentity:async()=>B});
    const otherStatus=await (await other(new Request('https://whooplens.tech/v1/health-connect/status'),env(db))).json();
    assert.equal(otherStatus.stored_records,0);
    const withdrawn=await (await route(new Request('https://whooplens.tech/v1/health-connect',{
      method:'DELETE',headers:{'content-type':'application/json'},
      body:JSON.stringify({consent:'delete-my-health-connect-records'})
    }),env(db))).json();
    assert.equal(withdrawn.deleted,1);
    assert.equal(withdrawn.consent,'withdrawn');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,0);
    const after=await (await route(new Request('https://whooplens.tech/v1/health-connect/status'),env(db))).json();
    assert.equal(after.consent,'withdrawn');
    assert.equal(after.stored_records,0);
  }finally{db.close();}
});
test('MCP import and withdrawal use the verified account and stay off without the flag',async()=>{
  const db=fixture();try{
    const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
    const call=(name,args,enabled)=>handleMcpRpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}},{
      db,userId:A,env:{WEB_HEALTH_IMPORT_ENABLED:enabled?'true':'false',WHOOP_OAUTH_ENABLED:'true'}
    },{...transport,modern:false});
    const off=await call('import_health_connect_file',{consent:'store-health-connect-file',file_json:JSON.stringify(file)},false);
    assert.equal(off.result.isError,true);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,0);
    const on=await call('import_health_connect_file',{consent:'store-health-connect-file',file_json:JSON.stringify(file)},true);
    assert.equal(on.result.isError,undefined);
    assert.equal(JSON.parse(on.result.content[0].text).stored,1);
    assert.equal(db.sqlite.prepare('SELECT user_id FROM health_connect_records').get().user_id,A);
    const gone=await call('withdraw_health_connect_import',{confirm:'delete-my-health-connect-records'},true);
    assert.equal(JSON.parse(gone.result.content[0].text).deleted,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(B).c,0);
  }finally{db.close();}
});
test('a failed row rolls back the whole import, including consent',async()=>{
  const {importHealthConnectFile,healthConnectStatus,IMPORT_CONSENT}=await import('../src/health-import.mjs');
  const db=fixture();try{
    const second={...file.records[0],record_key:'daily:2026-10-09:local',
      observed_at:'2026-10-09T05:00:00Z',ended_at:'2026-10-10T05:00:00Z',local_date:'2026-10-09'};
    db.sqlite.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON health_connect_records
      WHEN NEW.record_key='daily:2026-10-09:local' BEGIN SELECT RAISE(ABORT,'synthetic'); END;`);
    await assert.rejects(importHealthConnectFile(db,A,{...file,records:[file.records[0],second]},IMPORT_CONSENT,{now}),
      /Import unavailable/);
    const status=await healthConnectStatus(db,A);
    assert.equal(status.stored_records,0);
    assert.equal(status.consent,'none');
    db.sqlite.exec('DROP TRIGGER fail_second');
    const ok=await importHealthConnectFile(db,A,{...file,records:[file.records[0],second]},IMPORT_CONSENT,{now});
    assert.equal(ok.stored,2);
  }finally{db.close();}
});
