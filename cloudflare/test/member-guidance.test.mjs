// Shared member guidance: feature states, Health Connect token versus data,
// seat-role boundaries and evidence labels. Synthetic members only: an owner,
// an "Amy-like" public member whose phone data arrives, and a "Kimberly-like"
// public member whose token is issued but whose delivery stores nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {d1Database} from './d1-sqlite.mjs';
import {connect} from './audit-fixtures.mjs';
import {handleMcpRpc,validateMcpTransport} from '../src/mcp.mjs';
import {healthConnectWebhook,ISSUE_CONSENT} from '../src/health-connect-webhook.mjs';
import {featureStates,accountStatus,FeatureDisabled} from '../src/member-guidance.mjs';
import {hostInstructions,hostInstructionsFor} from '../src/host-instructions.mjs';

const OWNER='0a0a0a0a-0000-4000-8000-00000000000a';
const AMYLIKE='0b0b0b0b-0000-4000-8000-00000000000b';
const KIMLIKE='0c0c0c0c-0000-4000-8000-00000000000c';
const NEWBIE='0d0d0d0d-0000-4000-8000-00000000000d';
const NOW=Date.parse('2026-10-18T22:00:00Z');
const transport=validateMcpTransport(new Request('https://whooplens.tech/mcp',{headers:{'mcp-protocol-version':'2025-11-25'}}),{jsonrpc:'2.0',id:1,method:'tools/call'});
const flagsOn={HEALTH_CONNECT_WEBHOOK_ENABLED:'true',WEB_HEALTH_IMPORT_ENABLED:'true',WHOOP_OAUTH_ENABLED:'true',
  WHOOP_CLIENT_ID:'synthetic-client',WHOOP_CLIENT_SECRET:'synthetic-secret-123',WHOOP_LENS_DEVELOPER_USER_ID:OWNER,
  WHOOP_TOKEN_AES256_KEY:'synthetic-key-not-a-real-secret',WHOOP_REDIRECT_URI:'https://whooplens.tech/api/whoop/callback'};

async function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  for(const id of [OWNER,AMYLIKE,KIMLIKE,NEWBIE]){
    sqlite.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase',?)").run(id,id);
    sqlite.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,1)').run(id);
  }
  await connect(sqlite,OWNER,'developer','access-'+OWNER);
  await connect(sqlite,AMYLIKE,'public','access-'+AMYLIKE);
  await connect(sqlite,KIMLIKE,'public','access-'+KIMLIKE);
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
async function call(db,userId,name,args={},env=flagsOn){
  const response=await handleMcpRpc({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:args}},
    {db,userId,env},{...transport,modern:false});
  return response.result;
}
const parse=result=>JSON.parse(result.content[0].text);
function deliver(db,token,body){
  return healthConnectWebhook(new Request('https://whooplens.tech/api/health-connect/webhook',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)}),
    {DB:db,HEALTH_CONNECT_WEBHOOK_ENABLED:'true'},{now:NOW});
}
const envelope=extra=>({timestamp:'2026-10-18T21:00:00.000Z',app_version:'1.9.22',...extra});
const steps=n=>({count:n,start_time:'2026-10-17T00:00:00Z',end_time:'2026-10-18T00:00:00Z',metadata:{id:'synthetic-steps',lastModifiedTime:'2026-10-18T01:00:00Z'}});
async function issue(db,userId){
  const data=parse(await call(db,userId,'issue_health_connect_ingest_token',{consent:ISSUE_CONSENT}));
  return {data,token:data.header_value.slice('Bearer '.length)};
}

test('token issuance says no data has arrived and how to verify it',async()=>{
  const db=await fixture();try{
    const {data}=await issue(db,KIMLIKE);
    assert.equal(data.shown_once,true);
    assert.equal(data.this_call_delivered_data,false);
    assert.ok(!('data_received' in data));
    assert.match(data.next_step,/does not mean any data has arrived/);
    assert.match(data.verify_with,/records_stored/);
    assert.match(data.note,/accepted and still store zero records/);
  }finally{db.close();}
});

test('Kimberly-like member: token issued, delivery accepted with unsupported types only, zero records reported honestly',async()=>{
  const db=await fixture();try{
    const {token}=await issue(db,KIMLIKE);
    const before=(await call(db,KIMLIKE,'get_capabilities')).content[0].text;
    const pre=JSON.parse(before).account.health_connect;
    assert.equal(pre.ingest_token,'active');
    assert.equal(pre.records_stored,0);
    assert.equal(pre.latest_authenticated_delivery_window_at,null);
    const response=await deliver(db,token,envelope({weight:[{kg:1}],distance:[{m:1}]}));
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.stored,0);
    const hc=parse(await call(db,KIMLIKE,'get_capabilities')).account.health_connect;
    assert.equal(hc.phone_ingest_feature,'enabled');
    assert.equal(hc.ingest_token,'active');
    assert.equal(hc.records_stored,0);
    assert.equal(hc.latest_record_stored_at,null);
    assert.equal(hc.storage_consent,'granted');
    assert.equal(hc.latest_authenticated_delivery_window_at,new Date(NOW).toISOString());
    assert.match(hc.summary,/token is issued, but no Health Connect records are stored/);
    assert.match(hc.summary,/only a credential/);
    assert.ok(hc.not_verifiable_here.some(s=>/accepted delivery can store zero records/.test(s)));
    // The member's own seat role and boundaries.
    const account=parse(await call(db,KIMLIKE,'get_capabilities')).account;
    assert.equal(account.seat_role,'public');
    assert.ok(account.role_boundaries.some(s=>/only its own account data/.test(s)));
    assert.ok(account.role_boundaries.some(s=>/ask the server owner/.test(s)));
    assert.ok(!account.role_boundaries.some(s=>/owner\/developer seat/.test(s)));
    assert.deepEqual(account.request_budget,{state:'enabled',perMinute:25,perDay:1000});
  }finally{db.close();}
});

test('Amy-like member: delivered records are counted for her account only, never content or other members',async()=>{
  const db=await fixture();try{
    const amy=await issue(db,AMYLIKE);
    const kim=await issue(db,KIMLIKE);
    const response=await deliver(db,amy.token,envelope({steps:[steps(4321)]}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).stored,1);
    const amyText=(await call(db,AMYLIKE,'get_capabilities')).content[0].text;
    const amyHc=JSON.parse(amyText).account.health_connect;
    assert.equal(amyHc.records_stored,1);
    assert.match(amyHc.latest_record_stored_at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.match(amyHc.summary,/1 Health Connect record\(s\) are stored/);
    const kimText=(await call(db,KIMLIKE,'get_capabilities')).content[0].text;
    assert.equal(JSON.parse(kimText).account.health_connect.records_stored,0);
    for(const text of [amyText,kimText]){
      assert.ok(!text.includes('4321'),'no record content');
      assert.ok(!text.includes(amy.token)&&!text.includes(kim.token),'no token value');
      assert.ok(!/[0-9a-f]{64}/.test(text),'no token digest');
      assert.ok(!text.includes('synthetic-secret-123')&&!text.includes('synthetic-client'),'no secret values');
    }
    assert.ok(!amyText.includes(KIMLIKE)&&!amyText.includes(OWNER));
    assert.ok(!kimText.includes(AMYLIKE)&&!kimText.includes(OWNER));
  }finally{db.close();}
});

test('owner seat: developer boundaries, still own data only, owner budget',async()=>{
  const db=await fixture();try{
    const account=parse(await call(db,OWNER,'get_capabilities',{},{...flagsOn,WHOOP_DEVELOPER_LIMIT_PER_DAY:'2000'})).account;
    assert.equal(account.seat_role,'developer');
    assert.equal(account.whoop_connected,true);
    assert.ok(account.role_boundaries.some(s=>/including the owner, reads, imports, connects and deletes only its own/.test(s)));
    assert.ok(account.role_boundaries.some(s=>/server-wide AI summary total with no per-member breakdown/.test(s)));
    assert.equal(account.request_budget.state,'enabled');
    assert.equal(account.request_budget.perDay,2000);
    assert.equal(account.health_connect.ingest_token,'none');
    assert.match(account.health_connect.summary,/No Health Connect records are stored/);
  }finally{db.close();}
});

test('owner stays the developer seat after disconnecting WHOOP, matching get_ai_usage',async()=>{
  const db=await fixture();try{
    db.sqlite.prepare('DELETE FROM whoop_connections WHERE user_id=?').run(OWNER);
    const account=parse(await call(db,OWNER,'get_capabilities')).account;
    assert.equal(account.seat_role,'developer');
    assert.equal(account.seat_role_source,'Server owner setting.');
    assert.equal(account.whoop_connected,false);
    assert.ok(account.role_boundaries.some(s=>/server-wide AI summary total/.test(s)));
    // No connection row: the limiter makes no WHOOP request, so no budget is claimed.
    assert.equal(account.request_budget.state,'not_applicable');
    // A public member is never promoted by the owner setting.
    assert.equal(parse(await call(db,AMYLIKE,'get_capabilities')).account.seat_role,'public');
  }finally{db.close();}
});

test('reissuing for an account with stored records keeps them and is scoped to the call',async()=>{
  const db=await fixture();try{
    const first=await issue(db,AMYLIKE);
    assert.equal((await (await deliver(db,first.token,envelope({steps:[steps(10)]}))).json()).stored,1);
    const again=await issue(db,AMYLIKE);
    assert.equal(again.data.replaced_previous,true);
    assert.equal(again.data.this_call_delivered_data,false);
    assert.match(again.data.next_step,/already stored for this account are unchanged/);
    const hc=parse(await call(db,AMYLIKE,'get_capabilities')).account.health_connect;
    assert.equal(hc.records_stored,1);
    assert.equal(hc.ingest_token,'active');
    assert.equal(hc.latest_authenticated_delivery_window_at,null);
    assert.match(hc.summary,/1 Health Connect record\(s\) are stored/);
  }finally{db.close();}
});

test('a developer seat row without the owner setting gets no server-wide AI total claim, matching get_ai_usage',async()=>{
  const db=await fixture();try{
    const env={...flagsOn};delete env.WHOOP_LENS_DEVELOPER_USER_ID;
    const account=parse(await call(db,OWNER,'get_capabilities',{},env)).account;
    assert.equal(account.seat_role,'developer');
    assert.ok(account.role_boundaries.some(s=>/owner\/developer seat/.test(s)));
    assert.ok(!account.role_boundaries.some(s=>/server-wide AI summary total/.test(s)));
    const other=parse(await call(db,OWNER,'get_capabilities',{},{...env,WHOOP_LENS_DEVELOPER_USER_ID:AMYLIKE})).account;
    assert.ok(!other.role_boundaries.some(s=>/server-wide AI summary total/.test(s)));
  }finally{db.close();}
});

test('member without a WHOOP connection: seat role reported as unknown, with the reason',async()=>{
  const db=await fixture();try{
    const account=parse(await call(db,NEWBIE,'get_capabilities')).account;
    assert.equal(account.seat_role,'unknown');
    assert.equal(account.whoop_connected,false);
    assert.match(account.seat_role_source,/No WHOOP connection record yet/);
    assert.equal(account.request_budget.state,'not_applicable');
    assert.equal(account.role_boundaries.length,2);
  }finally{db.close();}
});

test('revoked token is reported as revoked, not active',async()=>{
  const db=await fixture();try{
    await issue(db,KIMLIKE);
    await call(db,KIMLIKE,'revoke_health_connect_ingest_token',{confirm:'revoke-health-connect-ingest-token'});
    const hc=parse(await call(db,KIMLIKE,'get_capabilities')).account.health_connect;
    assert.equal(hc.ingest_token,'revoked');
    assert.equal(hc.token_issued_at,null);
  }finally{db.close();}
});

test('feature states: enabled, disabled and not_configured come from flags and binding presence only',()=>{
  const byId=env=>Object.fromEntries(featureStates(env).map(f=>[f.id,f.state]));
  const off=byId({});
  for(const state of Object.values(off))assert.equal(state,'disabled');
  const half=byId({WHOOP_OAUTH_ENABLED:'true',AI_SUMMARY_ENABLED:'true',HEALTH_CONNECT_WEBHOOK_ENABLED:'true'});
  assert.equal(half.whoop_connection,'not_configured');
  assert.equal(half.ai_summaries,'not_configured');
  assert.equal(half.health_connect_phone_ingest,'enabled');
  assert.equal(half.health_connect_withdraw,'enabled');
  assert.equal(half.health_connect_file_import,'disabled');
  const analytics={AI_ANALYTICS_ACCOUNT_ID:'0123456789abcdef0123456789abcdef',AI_ACCOUNT_ANALYTICS_TOKEN:'synthetic-analytics-token-0001'};
  const full=byId({...flagsOn,AI_SUMMARY_ENABLED:'true',AI:{run(){}},STRESS_ESTIMATE_ENABLED:'true',...analytics});
  // An unsupported model name means every summary is a template.
  assert.equal(byId({AI_SUMMARY_ENABLED:'true',AI:{run(){}},...analytics,AI_SUMMARY_MODEL:'not-a-model'}).ai_summaries,'not_configured');
  // Binding present but the budget settings missing or malformed: template-only, not enabled.
  for(const drop of ['AI_ANALYTICS_ACCOUNT_ID','AI_ACCOUNT_ANALYTICS_TOKEN']){
    const env={AI_SUMMARY_ENABLED:'true',STRESS_ESTIMATE_ENABLED:'true',AI:{run(){}},...analytics};delete env[drop];
    assert.equal(byId(env).ai_summaries,'not_configured',drop);
    assert.equal(byId(env).experimental_stress_estimate,'not_configured',drop);
  }
  assert.equal(byId({AI_SUMMARY_ENABLED:'true',AI:{run(){}},...analytics,AI_ANALYTICS_ACCOUNT_ID:'nope'}).ai_summaries,'not_configured');
  assert.ok(!JSON.stringify(featureStates({AI_SUMMARY_ENABLED:'true',AI:{run(){}},...analytics})).includes('synthetic-analytics-token'));
  assert.equal(full.whoop_connection,'enabled');
  assert.equal(full.ai_summaries,'enabled');
  assert.equal(full.experimental_stress_estimate,'enabled');
  // Same check as connect_whoop: client, secret, a token key and the approved redirect.
  for(const missing of ['WHOOP_CLIENT_ID','WHOOP_CLIENT_SECRET','WHOOP_TOKEN_AES256_KEY','WHOOP_REDIRECT_URI']){
    const env={...flagsOn};delete env[missing];
    assert.equal(byId(env).whoop_connection,'not_configured',missing);
  }
  assert.equal(byId({...flagsOn,WHOOP_REDIRECT_URI:'https://elsewhere.invalid/cb'}).whoop_connection,'not_configured');
  const nextOnly={...flagsOn,WHOOP_TOKEN_AES256_KEY_NEXT:flagsOn.WHOOP_TOKEN_AES256_KEY};delete nextOnly.WHOOP_TOKEN_AES256_KEY;
  assert.equal(byId(nextOnly).whoop_connection,'enabled');
  // Exact "true" only, like every other flag on this server.
  assert.equal(byId({HEALTH_CONNECT_WEBHOOK_ENABLED:'TRUE'}).health_connect_phone_ingest,'disabled');
  assert.ok(!JSON.stringify(featureStates(flagsOn)).includes('synthetic-secret-123'));
});

test('a listed tool whose feature is off says so instead of a generic WHOOP error, and changes nothing',async()=>{
  const db=await fixture();try{
    const off={WHOOP_LENS_DEVELOPER_USER_ID:OWNER};
    for(const [name,args,feature] of [
      ['issue_health_connect_ingest_token',{consent:ISSUE_CONSENT},'health_connect_phone_ingest'],
      ['revoke_health_connect_ingest_token',{confirm:'revoke-health-connect-ingest-token'},'health_connect_phone_ingest'],
      ['disconnect_whoop',{},'whoop_connection'],
      ['connect_whoop',{},'whoop_connection']
    ]){
      const result=await call(db,KIMLIKE,name,args,off);
      assert.equal(result.isError,true,name);
      const text=result.content[0].text;
      assert.match(text,new RegExp(`This feature \\(${feature}\\) is turned off on this WHOOP Lens server\\. Nothing was changed\\.`),name);
      assert.doesNotMatch(text,/WHOOP data is unavailable/);
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM health_connect_ingest_tokens').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM whoop_connections').get().n,3);
    const caps=parse(await call(db,KIMLIKE,'get_capabilities',{},off));
    assert.equal(caps.server_features.find(f=>f.id==='health_connect_phone_ingest').state,'disabled');
    assert.equal(caps.account.health_connect.phone_ingest_feature,'disabled');
  }finally{db.close();}
  assert.ok(new FeatureDisabled('x') instanceof Error);
});

test('status reads fail soft: the catalog still answers and labels Health Connect unverified',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  const db=d1Database(sqlite);
  try{
    const status=await accountStatus(db,KIMLIKE,{},{now:NOW});
    assert.equal(status.health_connect.status,'unknown');
    assert.match(status.health_connect.summary,/unverified/);
    assert.equal(status.as_of,new Date(NOW).toISOString());
  }finally{sqlite.close();}
});

test('host instructions carry the shared guidance for every flag combination',()=>{
  for(const env of [undefined,{},flagsOn,{STRESS_ESTIMATE_ENABLED:'true',AI_SUMMARY_ENABLED:'true'},{FLARE_JOURNAL_ENABLED:'true'}]){
    const text=hostInstructionsFor(env);
    assert.match(text,/server_features reports each feature as enabled, disabled or not_configured/);
    assert.match(text,/issuing an ingest token only creates a credential\. It does not mean any data has arrived/);
    assert.match(text,/Every seat, including the owner, can read and change only its own data/);
    assert.match(text,/report unknown as unknown, with seat_role_source, and do not guess a role/);
    assert.match(text,/No tool approves members, changes seats or roles, or reads another account/);
    assert.match(text,/cite the tool and field that supports each claim/);
    assert.match(text,/as unverified/);
  }
  assert.match(hostInstructions,/phone-side settings\./);
});
