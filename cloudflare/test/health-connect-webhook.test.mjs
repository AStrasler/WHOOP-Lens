import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createStagingRouter} from '../src/router.mjs';
import {d1Database} from './d1-sqlite.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
import {healthConnectWebhook,ISSUE_CONSENT,REVOKE_CONFIRM} from '../src/health-connect-webhook.mjs';
import {withdrawHealthConnectImport,WITHDRAW_CONSENT} from '../src/health-import.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW=Date.parse('2026-10-13T03:00:00Z');
const UNSUPPORTED=['distance','active_calories','total_calories','weight','height','blood_pressure','blood_glucose','oxygen_saturation','body_temperature','skin_temperature','respiratory_rate','resting_heart_rate','heart_rate_variability','hydration','nutrition','basal_metabolic_rate','body_fat','lean_body_mass','body_water_mass','bmi','vo2_max','bone_mass','menstruation_flow','menstruation_period','intermenstrual_bleeding','ovulation_test','cervical_mucus','sexual_activity','basal_body_temperature'];
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0001_initial.sql','0004_medical_context_review.sql','0006_health_import_consent.sql','0007_health_connect_ingest.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  for(const id of [A,B]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
  }
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
function env(db,enabled=true){
  return {DB:db,MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',
    WEB_HEALTH_IMPORT_ENABLED:'true',HEALTH_CONNECT_WEBHOOK_ENABLED:enabled?'true':'false'};
}
function post(db,token,body,enabled=true,options={}){
  return healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{
    method:'POST',headers:{'content-type':'application/json',authorization:token?`Bearer ${token}`:''},
    body:typeof body==='string'?body:JSON.stringify(body)
  }),env(db,enabled),{now:NOW,...options});
}
const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
function call(db,userId,name,args,enabled=true){
  return handleMcpRpc({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:args}},{
    db,userId,env:{WEB_HEALTH_IMPORT_ENABLED:'false',HEALTH_CONNECT_WEBHOOK_ENABLED:enabled?'true':'false',WHOOP_OAUTH_ENABLED:'true'}
  },{...transport,modern:false});
}
async function issue(db,userId){
  const result=await call(db,userId,'issue_health_connect_ingest_token',{consent:ISSUE_CONSENT});
  assert.equal(result.result.isError,undefined);
  const data=JSON.parse(result.result.content[0].text);
  assert.equal(data.shown_once,true);
  assert.equal(data.header_name,'Authorization');
  assert.match(data.header_value,/^Bearer hct_[A-Za-z0-9_-]{43}$/);
  return data.header_value.slice('Bearer '.length);
}
function payload(extra={}){
  return {timestamp:'2026-10-13T03:00:00.000Z',app_version:'1.9.22',user_id:B,...extra};
}
const stepVersion=(count,modified)=>({count,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',
  metadata:{id:'versioned-step',lastModifiedTime:modified}});
test('in-flight webhook cannot write after token revocation, withdrawal, rotation or membership removal',async()=>{
  for(const action of ['revoke','withdraw','rotate','membership']){
    const db=fixture();try{
      const token=await issue(db,A),other=await issue(db,B);
      await post(db,other,payload({steps:[stepVersion(777,'2026-10-13T02:00:00Z')]}));
      let release,started;
      const gate=new Promise(resolve=>{started=resolve;});
      const body=new ReadableStream({start(controller){release=()=>{
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload({steps:[stepVersion(123,'2026-10-13T02:00:00Z')]}))));
        controller.close();
      };},pull(){started();}});
      const pending=healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{
        method:'POST',duplex:'half',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body
      }),env(db),{now:NOW});
      // Observe the completed authorization/rate reservation, not scheduler timing.
      while(db.sqlite.prepare('SELECT window_hits FROM health_connect_ingest_tokens WHERE user_id=? AND revoked_at IS NULL').get(A).window_hits===0)
        await new Promise(resolve=>setImmediate(resolve));
      await gate;
      if(action==='withdraw')await withdrawHealthConnectImport(db,A,WITHDRAW_CONSENT);
      if(action==='revoke')await call(db,A,'revoke_health_connect_ingest_token',{confirm:REVOKE_CONFIRM});
      if(action==='rotate')await issue(db,A);
      if(action==='membership')db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
      release();
      const result=await pending;
      assert.equal(result.status,403,action);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(A).n,0,action);
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records WHERE user_id=?').get(B).n,1);
    }finally{db.close();}
  }
});
test('duplicate versions within an upload keep newest modification regardless of order',async()=>{
  for(const reverse of [false,true]){
    const db=fixture();try{
      const token=await issue(db,A);
      const rows=[stepVersion(20,'2026-10-13T02:00:00Z'),stepVersion(10,'2026-10-13T01:00:00Z')];
      if(reverse)rows.reverse();
      assert.equal((await post(db,token,payload({steps:rows}))).status,200);
      const read=()=>JSON.parse(db.sqlite.prepare('SELECT payload_json FROM health_connect_records WHERE user_id=?').get(A).payload_json).count;
      assert.equal(read(),20);
      await post(db,token,payload({steps:[stepVersion(5,undefined)]}));
      assert.equal(read(),20,'unversioned retry must not downgrade versioned data');
      await post(db,token,payload({steps:[stepVersion(30,'2026-10-13T03:00:00Z')]}));
      assert.equal(read(),30);
    }finally{db.close();}
  }
});
test('webhook auth failure, disabled flag, and a foreign user id never write rows',async()=>{
  const db=fixture();
  const logs=[];
  const originals=Object.fromEntries(['log','info','warn','error','debug'].map(name=>[name,console[name]]));
  for(const name of Object.keys(originals)) console[name]=(...args)=>logs.push(args.map(String).join(' '));
  try{
    const off=await post(db,'hct_'+'a'.repeat(43),payload(),false);
    assert.equal(off.status,503);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,0);
    const token=await issue(db,A);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_ingest_tokens WHERE token_hash=?').get(token).c,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) c FROM health_connect_ingest_tokens WHERE length(token_hash)=64").get().c,1);
    const missing=await post(db,null,payload());
    const wrong=await post(db,'hct_'+'b'.repeat(43),payload());
    const basic=await healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{
      method:'POST',headers:{'content-type':'application/json',authorization:'Basic aGk='},body:'{}'
    }),env(db),{now:NOW});
    assert.equal(missing.status,401);
    assert.equal(wrong.status,401);
    assert.equal(basic.status,401);
    assert.equal((await post(db,token,'{')).status,400);
    assert.equal((await post(db,token,{app_version:'1.9.22'})).status,400);
    const saved=await post(db,token,payload({steps:[{count:10,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',user_id:B,metadata:{id:'step-a',data_origin:'com.sec.android.app.shealth'}}]}));
    assert.equal(saved.status,200);
    const row=db.sqlite.prepare('SELECT user_id,metric,record_key,payload_json FROM health_connect_records').get();
    assert.equal(row.user_id,A);
    assert.equal(row.metric,'steps_daily');
    assert.equal(row.record_key,'hc:step-a');
    assert.equal(JSON.parse(row.payload_json).count,10);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(B).c,0);
    const body=await saved.json();
    assert.equal(JSON.stringify(body).includes(B),false);
    assert.equal(JSON.stringify(body).includes(token),false);
    assert.equal(logs.some(line=>line.includes(token)||line.includes('step-a')),false);
    db.sqlite.prepare('UPDATE whoop_members SET active=0 WHERE user_id=?').run(A);
    assert.equal((await post(db,token,payload({steps:[{count:1,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-12T01:00:00Z'}]}))).status,403);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records').get().c,1);
  }finally{
    for(const [name,fn] of Object.entries(originals)) console[name]=fn;
    db.close();
  }
});
test('two members stay isolated, retries upsert, and unsupported types still return 2xx',async()=>{
  const db=fixture();try{
    const tokenA=await issue(db,A);
    const tokenB=await issue(db,B);
    const steps=(count,id='step-1',modified='2026-10-13T02:00:00Z')=>({
      count,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',
      metadata:{id,data_origin:'com.sec.android.app.shealth',lastModifiedTime:modified}
    });
    const common={
      steps:[steps(100)],
      sleep:[{session_end_time:'2026-10-13T06:00:00Z',duration_seconds:28800,stages:[{stage:'deep',start_time:'2026-10-12T22:00:00Z',end_time:'2026-10-13T00:00:00Z',duration_seconds:7200}],metadata:{id:'sleep-1',data_origin:'com.sec.android.app.shealth'}}],
      heart_rate:[
        {bpm:72,time:'2026-10-13T08:15:00Z',metadata:{id:'hr-1'}},
        {time:'2026-10-13T08:16:00Z',avg:80.5,min:70,max:90,bpm:80.5,metadata:{id:'hr-2'}}
      ],
      exercise:[{type:'running',start_time:'2026-10-13T07:00:00Z',end_time:'2026-10-13T07:30:00Z',duration_seconds:1800,metadata:{id:'ex-1',data_origin:'com.sec.android.app.shealth'}}]
    };
    for(const key of UNSUPPORTED) common[key]=[{marker:key}];
    const first=await (await post(db,tokenA,payload(common))).json();
    assert.equal(first.ok,true);
    assert.equal(first.stored,5);
    assert.equal(first.skipped,UNSUPPORTED.length+1);
    assert.equal(first.skipped_types.user_id,1);
    assert.equal(first.skipped_types.heart_rate_variability,1);
    assert.equal(first.skipped_types.resting_heart_rate,1);
    assert.equal(first.rejected,0);
    const metrics=db.sqlite.prepare('SELECT metric,COUNT(*) c FROM health_connect_records WHERE user_id=? GROUP BY metric ORDER BY metric').all(A);
    assert.deepEqual(metrics.map(row=>row.metric),['exercise_session','heart_rate','sleep_session','steps_daily']);
    const sleep=JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE metric='sleep_session'").get().payload_json);
    assert.equal(sleep.duration_seconds,28800);
    assert.equal(sleep.stages[0].stage,'deep');
    const hr=JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE record_key='hc:hr-2'").get().payload_json);
    assert.equal(hr.bpm,80.5);
    assert.equal(hr.min,70);
    const again=await (await post(db,tokenA,payload({steps:[steps(250)]}))).json();
    assert.equal(again.stored,1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) c FROM health_connect_records WHERE user_id=? AND metric='steps_daily'").get(A).c,1);
    assert.equal(JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE record_key='hc:step-1'").get().payload_json).count,250);
    const stale=await (await post(db,tokenA,payload({steps:[steps(1,'step-1','2026-10-13T01:00:00Z')]}))).json();
    assert.equal(stale.stored,1);
    assert.equal(JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE record_key='hc:step-1'").get().payload_json).count,250);
    const plain={count:4,start_time:'2026-10-12T10:00:00Z',end_time:'2026-10-12T11:00:00Z',metadata:{data_origin:'com.sec.android.app.shealth',recording_method:'automatically_recorded'}};
    await post(db,tokenA,payload({steps:[plain]}));
    await post(db,tokenA,payload({steps:[{...plain,count:9}]}));
    const plainRows=db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE user_id=? AND record_key LIKE 'k:%'").all(A);
    assert.equal(plainRows.length,1);
    assert.equal(JSON.parse(plainRows[0].payload_json).count,9);
    const other=await (await post(db,tokenB,payload({steps:[steps(3,'step-1')],heart_rate_variability:[{rmssd_millis:20,time:'2026-10-13T08:00:00Z'}]}))).json();
    assert.equal(other.stored,1);
    assert.equal(other.skipped,2);
    assert.equal(other.skipped_types.user_id,1);
    assert.equal(other.skipped_types.heart_rate_variability,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(B).c,1);
    assert.equal(JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE user_id=? AND record_key='hc:step-1'").get(A).payload_json).count,250);
    assert.equal(JSON.parse(db.sqlite.prepare("SELECT payload_json FROM health_connect_records WHERE user_id=? AND record_key='hc:step-1'").get(B).payload_json).count,3);
    const huge=await post(db,tokenA,payload({steps:[{count:1,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-12T01:00:00Z'}]}),true,{maxBody:40});
    assert.equal(huge.status,413);
    const crowded=await post(db,tokenA,payload({heart_rate:[{bpm:60,time:'2026-10-13T09:00:00Z'},{bpm:61,time:'2026-10-13T09:01:00Z'}]}),true,{maxStored:1});
    assert.equal(crowded.status,413);
  }finally{db.close();}
});
test('issuing a token grants consent, rotation and withdrawal revoke it, and the other member is untouched',async()=>{
  const db=fixture();try{
    const off=await call(db,A,'issue_health_connect_ingest_token',{consent:ISSUE_CONSENT},false);
    assert.equal(off.result.isError,true);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_ingest_tokens').get().c,0);
    const first=await issue(db,A);
    const consent=db.sqlite.prepare('SELECT purpose,withdrawn_at FROM health_import_consent WHERE user_id=?').get(A);
    assert.equal(consent.purpose,'health_connect_file');
    assert.equal(consent.withdrawn_at,null);
    const second=await issue(db,A);
    assert.notEqual(first,second);
    assert.equal((await post(db,first,payload({steps:[{count:1,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-12T01:00:00Z'}]}))).status,401);
    const kept=await issue(db,B);
    await post(db,second,payload({steps:[{count:8,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',metadata:{id:'owned-by-a'}}]}));
    await post(db,kept,payload({steps:[{count:2,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',metadata:{id:'owned-by-b'}}]}));
    const revoked=await call(db,A,'revoke_health_connect_ingest_token',{confirm:REVOKE_CONFIRM});
    assert.equal(JSON.parse(revoked.result.content[0].text).revoked,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(A).c,1);
    assert.equal((await post(db,second,payload())).status,401);
    assert.equal((await post(db,kept,payload({steps:[{count:2,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-13T00:00:00Z',metadata:{id:'owned-by-b'}}]}))).status,200);
    const fresh=await issue(db,A);
    const gone=await call(db,A,'withdraw_health_connect_import',{confirm:'delete-my-health-connect-records'});
    const withdrawal=JSON.parse(gone.result.content[0].text);
    assert.equal(withdrawal.deleted,1);
    assert.equal(withdrawal.consent,'withdrawn');
    assert.equal(withdrawal.ingest_tokens_revoked,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(A).c,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) c FROM health_connect_records WHERE user_id=?').get(B).c,1);
    assert.equal((await post(db,fresh,payload({steps:[{count:1,start_time:'2026-10-12T00:00:00Z',end_time:'2026-10-12T01:00:00Z'}]}))).status,401);
    assert.equal((await post(db,kept,payload())).status,200);
    db.sqlite.exec(readFileSync(new URL('../migrations/0007_health_connect_ingest.sql',import.meta.url),'utf8'));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) c FROM health_connect_ingest_tokens WHERE user_id=?").get(B).c,1);
  }finally{db.close();}
});
test('the router hides the webhook until its flag is on and limits repeat posts',async()=>{
  const db=fixture();try{
    const route=createStagingRouter({verifyIdentity:async()=>{throw Error('MCP identity must not run');}});
    const blocked=await route(new Request('https://whooplens.tech/api/health-connect/webhook',{method:'POST'}),env(db,false));
    assert.equal(blocked.status,503);
    const token=await issue(db,A);
    let limited=0;
    for(let i=0;i<3;i++){
      const response=await healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify(payload())
      }),env(db),{now:NOW,maxHits:2});
      if(response.status===429) limited++;
      else assert.equal(response.status,200);
    }
    assert.equal(limited,1);
    const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
    const resource=readFileSync(new URL('../oauth/resource/wrangler.jsonc',import.meta.url),'utf8');
    assert.match(cfg,/"HEALTH_CONNECT_WEBHOOK_ENABLED"\s*:\s*"false"/);
    assert.match(resource,/"HEALTH_CONNECT_WEBHOOK_ENABLED"\s*:\s*"false"/);
  }finally{db.close();}
});

test('a failed later upload chunk rolls back all records and the retry succeeds',async()=>{
  const db=fixture();try{
    const token=await issue(db,A);
    const rows=Array.from({length:1800},(_,i)=>({...stepVersion(i,'2026-10-13T02:00:00Z'),metadata:{id:'large-'+String(i).padStart(4,'0')}}));
    db.sqlite.exec("CREATE TRIGGER fail_late BEFORE INSERT ON health_connect_records WHEN NEW.record_key='hc:large-1799' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await post(db,token,payload({steps:rows}))).status,503);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records').get().n,0);
    db.sqlite.exec('DROP TRIGGER fail_late');
    assert.equal((await post(db,token,payload({steps:rows}))).status,200);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records').get().n,1800);
    assert.equal((await post(db,token,payload({steps:rows}))).status,200);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_records').get().n,1800);
  }finally{db.close();}
});

test('malformed calendar dates never silently normalize into a different day',async()=>{
  const db=fixture();try{
    const token=await issue(db,A);
    assert.equal((await post(db,token,payload({timestamp:'not-a-date'}))).status,400);
    const record={...stepVersion(10),start_time:'2026-02-30T00:00:00Z',end_time:'2026-03-03T00:00:00Z'};
    const result=await (await post(db,token,payload({steps:[record]}))).json();
    assert.equal(result.rejected,1);assert.equal(result.stored,0);
    const valid={...record,start_time:'2026-02-28T00:00:00-06:00'};
    assert.equal((await (await post(db,token,payload({steps:[valid]}))).json()).stored,1);
    assert.equal(db.sqlite.prepare('SELECT observed_at FROM health_connect_records').get().observed_at,'2026-02-28T06:00:00.000Z');
  }finally{db.close();}
});
