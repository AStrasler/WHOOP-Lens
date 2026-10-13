import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {handleMcpRpc} from "../src/mcp.mjs";
import {d1Database} from "./d1-sqlite.mjs";
import {reconcileQuota,reserveQuota,userScope} from "../src/ai-quota.mjs";
import {
  ACCOUNT_NEURON_LIMIT,ACCOUNT_SAFETY_MARGIN,ANALYTICS_CACHE_MS,ANALYTICS_STALE_MS,
  ANALYTICS_ACCOUNT_ID,ANALYTICS_TOKEN_SECRET,accountCeiling,analyticsSample,loadAccountBudget,
  neuronsFromAnalyticsBody
} from "../src/ai-account.mjs";
import {attachSummary} from "../src/ai-summary.mjs";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DAY="2026-10-13";
const NOW=Date.parse(DAY+"T12:00:00Z");
const ACCOUNT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN="synthetic-analytics-token";
const modern={modern:true};
function openDb(){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0009_ai_usage.sql",import.meta.url),"utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0010_ai_account_snapshot.sql",import.meta.url),"utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0012_ai_usage_event.sql",import.meta.url),"utf8"));
  return {sqlite,...d1Database(sqlite),close(){sqlite.close();}};
}
function page(){
  return {records:[{created_at:DAY+"T08:00:00Z",score_state:"SCORED",score:{recovery_score:40}}],next_token:null};
}
function analyticsEnv(query,extra={}){
  return {
    AI_SUMMARY_ENABLED:"true",
    [ANALYTICS_ACCOUNT_ID]:ACCOUNT,
    [ANALYTICS_TOKEN_SECRET]:TOKEN,
    AI_ANALYTICS_QUERY:query,
    ...extra
  };
}
function seed(db,userUsed,globalUsed){
  db.sqlite.prepare("INSERT INTO ai_usage(scope,day,used,cap) VALUES(?,?,?,2500)").run(userScope(A),DAY,userUsed);
  db.sqlite.prepare("INSERT INTO ai_usage(scope,day,used,cap) VALUES('global',?,?,7500)").run(DAY,globalUsed);
}
function used(db,scope="global"){
  return db.sqlite.prepare("SELECT used FROM ai_usage WHERE scope=?").get(scope)?.used??null;
}
function snapshot(db){
  return db.sqlite.prepare("SELECT neurons,local_used,fetched_at FROM ai_account_snapshot WHERE day=?").get(DAY);
}
const accepted="The recovery score was 40 on 2026-10-13.";

test("migration 0010 stores only the account neuron snapshot",()=>{
  const sql=readFileSync(new URL("../migrations/0010_ai_account_snapshot.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE IF NOT EXISTS ai_account_snapshot/);
  const create=sql.slice(sql.indexOf("CREATE TABLE"));
  assert.doesNotMatch(create,/prompt|output|health|token/i);
  const db=openDb();
  try{
    const columns=db.sqlite.prepare("PRAGMA table_info(ai_account_snapshot)").all().map(row=>row.name);
    assert.deepEqual(columns,["day","neurons","local_used","fetched_at","recent_local"]);
    const indexes=db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_usage_event'").all().map(row=>row.name);
    assert.ok(indexes.includes("ai_usage_event_day_at"));
    assert.equal(accountCeiling(8000,200,100),ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN-8100+200);
    assert.equal(accountCeiling(100,500),ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN);
    assert.equal(accountCeiling(8000,200),ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN-8000+200);
    assert.equal(accountCeiling(9600,0),-100);
    assert.equal(accountCeiling(-1,0),null);
    assert.equal(neuronsFromAnalyticsBody({data:{viewer:{accounts:[]}}}),null);
    assert.equal(neuronsFromAnalyticsBody({errors:[{message:"denied"}],data:{viewer:{accounts:[{aiInferenceAdaptiveGroups:[]}]}}}),null);
    assert.equal(neuronsFromAnalyticsBody({data:{viewer:{accounts:[{aiInferenceAdaptiveGroups:[]}]}}}),0);
    assert.equal(neuronsFromAnalyticsBody({data:{viewer:{accounts:[
      {aiInferenceAdaptiveGroups:[{sum:{neurons:100.2}}]},
      {aiInferenceAdaptiveGroups:[{sum:{neurons:25.1}}]}
    ]}}}),126);
  }finally{db.close();}
});

test("normal analytics usage reserves inside the account room",async()=>{
  const db=openDb();
  try{
    let queries=0,calls=0;
    const env=analyticsEnv(async(input)=>{
      queries++;
      assert.deepEqual(Object.keys(input).sort(),["accountId","end","start"]);
      assert.equal(input.accountId,ACCOUNT);
      assert.equal(input.start,DAY+"T00:00:00Z");
      assert.equal(input.end,"2026-10-14T00:00:00Z");
      assert.equal(JSON.stringify(input).includes(TOKEN),false);
      return {neurons:100};
    },{AI:{async run(){
      calls++;
      return {response:accepted,usage:{prompt_tokens:20,completion_tokens:8}};
    }}});
    const first=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env});
    assert.equal(first.summary.status,"model");
    assert.equal(calls,1);
    assert.equal(queries,1);
    assert.equal(snapshot(db).neurons,100);
    assert.equal(snapshot(db).local_used,0);
    assert.equal(snapshot(db).fetched_at,NOW);
    const second=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW+1000,env});
    assert.equal(second.summary.status,"model");
    assert.equal(calls,2);
    assert.equal(queries,1);
  }finally{db.close();}
});

test("account room subtracts outside usage once and keeps post-snapshot reservations",async()=>{
  const db=openDb();
  try{
    seed(db,0,200);
    let queries=0;
    const budget=await loadAccountBudget(db,analyticsEnv(async()=>{
      queries++;
      return {neurons:8000};
    }),{day:DAY,now:NOW});
    assert.equal(queries,1);
    assert.equal(budget.ok,true);
    assert.equal(budget.neurons,8000);
    assert.equal(budget.snapshotLocal,200);
    assert.equal(budget.accountCap,1700);
    const over=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1501,snapshotLocal:budget.snapshotLocal,accountCap:budget.accountCap
    });
    assert.equal(over.ok,false);
    assert.equal(used(db,"global"),200);
    assert.equal(used(db,userScope(A)),0);
    const fits=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1500,snapshotLocal:budget.snapshotLocal,accountCap:budget.accountCap
    });
    assert.equal(fits.ok,true);
    assert.equal(used(db,userScope(A)),1500);
    assert.equal(used(db,"global"),1700);
    db.sqlite.exec("DELETE FROM ai_usage");
    db.sqlite.prepare("DELETE FROM ai_account_snapshot").run();
    db.sqlite.prepare("INSERT INTO ai_account_snapshot(day,neurons,local_used,fetched_at) VALUES(?,?,?,?)")
      .run(DAY,8000,200,NOW);
    seed(db,0,400);
    queries=0;
    const cached=await loadAccountBudget(db,analyticsEnv(async()=>{
      queries++;
      return {neurons:0};
    }),{day:DAY,now:NOW+1000});
    assert.equal(queries,0);
    assert.equal(cached.cached,true);
    assert.equal(cached.snapshotLocal,200);
    const lagOver=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1301,snapshotLocal:cached.snapshotLocal,accountCap:cached.accountCap
    });
    assert.equal(lagOver.ok,false);
    assert.equal(used(db,"global"),400);
    const lagFits=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1300,snapshotLocal:cached.snapshotLocal,accountCap:cached.accountCap
    });
    assert.equal(lagFits.ok,true);
    assert.equal(used(db,"global"),1700);
    db.sqlite.exec("DELETE FROM ai_usage");
    seed(db,0,100);
    const refundedRoom=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1501,snapshotLocal:cached.snapshotLocal,accountCap:cached.accountCap
    });
    assert.equal(refundedRoom.ok,false);
    assert.equal(used(db,"global"),100);
    const refundedFits=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1500,snapshotLocal:cached.snapshotLocal,accountCap:cached.accountCap
    });
    assert.equal(refundedFits.ok,true);
    assert.equal(used(db,"global"),1600);
    const partial=await reserveQuota(db,{userId:A,day:DAY,estimate:1,snapshotLocal:0});
    assert.equal(partial.ok,false);
  }finally{db.close();}
});

test("outside account usage near the limit skips the model",async()=>{
  const db=openDb();
  try{
    let calls=0;
    const env=analyticsEnv(async()=>({neurons:9600}),{AI:{async run(){calls++;return {response:accepted};}}});
    const summary=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env});
    assert.equal(calls,0);
    assert.equal(summary.summary.status,"template");
    assert.equal(summary.records.length,1);
    assert.equal(used(db,userScope(A)),0);
    assert.equal(used(db,"global"),0);
    assert.equal(snapshot(db).neurons,9600);
    let upstreamCalls=0;
    const seen=[];
    const body=await handleMcpRpc({jsonrpc:"2.0",id:1,method:"tools/call",params:{
      name:"get_recovery",arguments:{summary:true}
    }},{
      db,userId:A,env,whoopRequest:async(_db,user,resource)=>{
        upstreamCalls++;
        seen.push([user,resource]);
        return page();
      }
    },modern);
    const parsed=JSON.parse(body.result.content[0].text);
    assert.equal(upstreamCalls,2);
    assert.deepEqual(seen,[[A,"recovery"],[A,"recovery"]]);
    assert.equal(parsed.records.length,1);
    assert.equal(parsed.summary.status,"template");
    assert.equal(calls,0);
  }finally{db.close();}
});

test("analytics failure and stale snapshots fail closed",async()=>{
  const db=openDb();
  try{
    let calls=0,queries=0;
    const failing=analyticsEnv(async()=>{queries++;throw Error("analytics down");},{
      AI:{async run(){calls++;return {response:accepted};}}
    });
    const down=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env:failing});
    assert.equal(down.summary.status,"template");
    assert.equal(calls,0);
    assert.equal(queries,1);
    assert.equal(used(db,userScope(A)),null);
    assert.equal(snapshot(db),undefined);
    db.sqlite.prepare("INSERT INTO ai_account_snapshot(day,neurons,local_used,fetched_at) VALUES(?,?,?,?)")
      .run(DAY,10,0,NOW-ANALYTICS_STALE_MS-1);
    const stale=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env:failing});
    assert.equal(stale.summary.status,"template");
    assert.equal(calls,0);
    assert.equal(queries,2);
    assert.equal(snapshot(db).fetched_at,NOW-ANALYTICS_STALE_MS-1);
    db.sqlite.prepare("UPDATE ai_account_snapshot SET fetched_at=? WHERE day=?").run(NOW-ANALYTICS_CACHE_MS-1,DAY);
    const refreshing=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env:failing});
    assert.equal(refreshing.summary.status,"template");
    assert.equal(calls,0);
    assert.equal(queries,3);
    db.sqlite.prepare("UPDATE ai_account_snapshot SET neurons=0, local_used=0, fetched_at=? WHERE day=?").run(NOW-1000,DAY);
    const fresh=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env:failing});
    assert.equal(fresh.summary.status,"model");
    assert.equal(calls,1);
    assert.equal(queries,3);
    for(const env of [
      {AI_SUMMARY_ENABLED:"true",[ANALYTICS_ACCOUNT_ID]:ACCOUNT,AI_ANALYTICS_QUERY:async()=>{queries++;return {neurons:0};}},
      {AI_SUMMARY_ENABLED:"true",[ANALYTICS_ACCOUNT_ID]:"not-an-account",[ANALYTICS_TOKEN_SECRET]:TOKEN,AI_ANALYTICS_QUERY:async()=>{queries++;return {neurons:0};}},
      {AI_SUMMARY_ENABLED:"true",[ANALYTICS_ACCOUNT_ID]:ACCOUNT,[ANALYTICS_TOKEN_SECRET]:"short-token",AI_ANALYTICS_QUERY:async()=>{queries++;return {neurons:0};}}
    ]){
      env.AI={async run(){calls++;}};
      const closed=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW+2000,env});
      assert.equal(closed.summary.status,"template");
    }
    assert.equal(calls,1);
    assert.equal(queries,3);
  }finally{db.close();}
});

test("the GraphQL analytics query sums neurons and fail closed on a bad response",async()=>{
  const db=openDb();
  try{
    let calls=0,seen=null;
    const env={
      AI_SUMMARY_ENABLED:"true",
      [ANALYTICS_ACCOUNT_ID]:ACCOUNT,
      [ANALYTICS_TOKEN_SECRET]:TOKEN,
      AI_ANALYTICS_FETCH:async(url,init)=>{
        seen={url,init};
        return {
          ok:true,
          async json(){
            return {data:{viewer:{accounts:[{
              aiInferenceAdaptiveGroups:[{sum:{neurons:100.2}},{sum:{neurons:25.1}}]
            }]}}};
          }
        };
      },
      AI:{async run(){
        calls++;
        return {response:accepted,usage:{prompt_tokens:20,completion_tokens:8}};
      }}
    };
    const summary=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW,env});
    assert.equal(summary.summary.status,"model");
    assert.equal(calls,1);
    assert.equal(seen.url,"https://api.cloudflare.com/client/v4/graphql");
    assert.equal(seen.init.method,"POST");
    assert.equal(seen.init.redirect,"error");
    assert.equal(seen.init.headers.authorization,"Bearer "+TOKEN);
    const body=JSON.parse(seen.init.body);
    assert.match(body.query,/aiInferenceAdaptiveGroups/);
    assert.match(body.query,/sum \{ neurons \}/);
    assert.equal(body.variables.accountTag,ACCOUNT);
    assert.equal(body.variables.start,DAY+"T00:00:00Z");
    assert.equal(body.variables.end,"2026-10-14T00:00:00Z");
    assert.equal(body.query.includes(TOKEN),false);
    assert.equal(seen.init.body.includes(TOKEN),false);
    assert.equal(snapshot(db).neurons,126);
    db.sqlite.prepare("DELETE FROM ai_account_snapshot").run();
    const responses=[
      {ok:false,body:{data:{}}},
      {ok:true,body:{errors:[{message:"no neurons"}]}},
      {ok:true,body:{data:{viewer:{accounts:[{aiInferenceAdaptiveGroups:[{sum:{}}]}]}}}},
      {ok:true,body:null,fail:true}
    ];
    for(const response of responses){
      let fetches=0;
      const broken={
        ...env,
        AI_ANALYTICS_FETCH:async()=>{
          fetches++;
          return {ok:response.ok,async json(){
            if(response.fail)throw Error("bad json");
            return response.body;
          }};
        },
        AI:{async run(){calls++;}}
      };
      const fallback=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:NOW+ANALYTICS_CACHE_MS+1,env:broken});
      assert.equal(fallback.summary.status,"template");
      assert.equal(fetches,1);
    }
    assert.equal(calls,1);
  }finally{db.close();}
});

test("analytics lag counts local reservations since the last counted call",async()=>{
  const db=openDb();
  try{
    seed(db,0,200);
    db.sqlite.prepare("INSERT INTO ai_usage_event(day,at_ms,amount) VALUES(?,?,?)").run(DAY,NOW-60*1000,100);
    const end=new Date(NOW-5*60*1000).toISOString();
    const budget=await loadAccountBudget(db,analyticsEnv(async()=>({neurons:8000,end})),{day:DAY,now:NOW});
    assert.equal(budget.ok,true);
    assert.equal(budget.recentLocal,100);
    assert.equal(budget.accountCap,ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN-8100+200);
    const over=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1401,snapshotLocal:budget.snapshotLocal,accountCap:budget.accountCap
    });
    assert.equal(over.ok,false);
    const fits=await reserveQuota(db,{
      userId:A,day:DAY,estimate:1400,snapshotLocal:budget.snapshotLocal,accountCap:budget.accountCap
    });
    assert.equal(fits.ok,true);
    assert.ok(db.sqlite.prepare("SELECT COUNT(*) AS n FROM ai_usage_event WHERE amount=1400").get().n>=1);
    db.sqlite.exec("DELETE FROM ai_usage");
    db.sqlite.prepare("DELETE FROM ai_account_snapshot").run();
    seed(db,0,500);
    const localWins=await loadAccountBudget(db,analyticsEnv(async()=>({neurons:100})),{day:DAY,now:NOW});
    assert.equal(localWins.ok,true);
    assert.equal(localWins.recentLocal,0);
    assert.equal(localWins.accountCap,ACCOUNT_NEURON_LIMIT-ACCOUNT_SAFETY_MARGIN);
    const dated=analyticsSample({data:{viewer:{accounts:[{aiInferenceAdaptiveGroups:[{
      dimensions:{datetime:end},sum:{neurons:10}
    }]}]}}});
    assert.equal(dated.neurons,10);
    assert.equal(dated.endMs,Date.parse(end));
    assert.equal(dated.freshAt,undefined);
  }finally{db.close();}
});

test("a last call hours ago stays fresh, and a stale or failed fetch uses the template",async()=>{
  const db=openDb();
  try{
    const callAt=Date.parse(DAY+"T13:00:00Z");
    const checkAt=Date.parse(DAY+"T15:00:00Z");
    seed(db,0,200);
    db.sqlite.prepare("INSERT INTO ai_usage_event(day,at_ms,amount) VALUES(?,?,?)").run(DAY,callAt+1000,100);
    db.sqlite.prepare("INSERT INTO ai_usage_event(day,at_ms,amount) VALUES(?,?,?)").run("2026-10-12",callAt,50);
    let calls=0;
    const env=analyticsEnv(async()=>({neurons:8000,end:new Date(callAt).toISOString()}),{
      AI:{async run(){calls++;return {response:accepted,usage:{prompt_tokens:20,completion_tokens:8}};}}
    });
    const budget=await loadAccountBudget(db,env,{day:DAY,now:checkAt});
    assert.equal(budget.ok,true);
    assert.equal(budget.recentLocal,100);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM ai_usage_event WHERE day='2026-10-12'").get().n,0);
    const summary=await attachSummary(page(),{db,userId:A,tool:"get_recovery",now:checkAt,env});
    assert.equal(summary.summary.status,"model");
    assert.equal(calls,1);
    db.sqlite.prepare("DELETE FROM ai_account_snapshot").run();
    calls=0;
    const stale=await attachSummary(page(),{
      db,userId:A,tool:"get_recovery",now:checkAt,
      env:analyticsEnv(async()=>({
        neurons:0,
        end:new Date(checkAt).toISOString(),
        freshAt:new Date(checkAt-ANALYTICS_STALE_MS-1000).toISOString()
      }),{AI:{async run(){calls++;return {response:accepted};}}})
    });
    assert.equal(stale.summary.status,"template");
    assert.equal(calls,0);
    assert.equal(snapshot(db),undefined);
    const failed=await attachSummary(page(),{
      db,userId:A,tool:"get_recovery",now:checkAt,
      env:analyticsEnv(async()=>{throw Error("analytics down");},{
        AI:{async run(){calls++;return {response:accepted};}}
      })
    });
    assert.equal(failed.summary.status,"template");
    assert.equal(calls,0);
    db.sqlite.exec("DELETE FROM ai_usage");
    db.sqlite.exec("DROP TABLE ai_usage_event");
    const denied=await reserveQuota(db,{userId:A,day:DAY,estimate:10});
    assert.equal(denied.ok,false);
    assert.equal(used(db,userScope(A)),0);
    assert.equal(used(db,"global"),0);
  }finally{db.close();}
});

test("parallel account reservations stop at the shared room",async()=>{
  const db=openDb();
  try{
    const estimate=100;
    const accountCap=300;
    const results=await Promise.all(Array.from({length:20},()=>
      reserveQuota(db,{userId:A,day:DAY,estimate,snapshotLocal:0,accountCap})));
    const successes=results.filter(row=>row.ok);
    assert.equal(successes.length,3);
    assert.equal(used(db,userScope(A)),300);
    assert.equal(used(db,"global"),300);
  }finally{db.close();}
});

test("concurrent refunds and adjustments keep both counters equal",async()=>{
  const db=openDb();
  try{
    seed(db,600,600);
    const refunds=await Promise.all(Array.from({length:20},()=>
      reconcileQuota(db,{userId:A,day:DAY,reserved:30,actual:10})));
    assert.equal(refunds.filter(row=>row.action==="refunded").length,20);
    assert.equal(used(db,userScope(A)),200);
    assert.equal(used(db,"global"),200);
    db.sqlite.prepare("UPDATE ai_usage SET used=50").run();
    const crowded=await Promise.all(Array.from({length:10},()=>
      reconcileQuota(db,{userId:A,day:DAY,reserved:30,actual:10})));
    assert.equal(crowded.filter(row=>row.action==="refunded").length,2);
    assert.equal(used(db,userScope(A)),10);
    assert.equal(used(db,"global"),10);
    assert.ok(used(db,userScope(A))>=0);
    db.sqlite.prepare("UPDATE ai_usage SET used=400").run();
    const mixed=await Promise.all([
      ...Array.from({length:8},()=>reconcileQuota(db,{userId:A,day:DAY,reserved:30,actual:10})),
      ...Array.from({length:8},()=>reconcileQuota(db,{userId:A,day:DAY,reserved:10,actual:40}))
    ]);
    assert.equal(mixed.filter(row=>row.ok).length,16);
    assert.equal(used(db,userScope(A)),480);
    assert.equal(used(db,"global"),480);
  }finally{db.close();}
});
