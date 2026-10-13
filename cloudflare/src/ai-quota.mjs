// Per-user and global daily neuron counters. The only AI storage.
// One UPDATE reserves both rows, or neither. Anything else is denied and undone.
export const USER_CAP=2500;
export const GLOBAL_CAP=7500;
export const GLOBAL_SCOPE="global";
const INSERT=`INSERT INTO ai_usage(scope, day, used, cap) VALUES (?1, ?2, 0, ?3)
ON CONFLICT(scope, day) DO NOTHING`;
const RESERVE=`UPDATE ai_usage
SET used = used + ?1
WHERE day = ?2
  AND scope IN (?3, 'global')
  AND (SELECT COUNT(*) FROM ai_usage
       WHERE day = ?2 AND scope IN (?3, 'global')
         AND used + ?1 <= cap) = 2
RETURNING scope, used`;
// ?4 is global used at the analytics snapshot. ?5 is 10000 - margin - analytics + that snapshot.
// Usage already inside the snapshot is not added again. Later reservations still shrink the room.
// A global counter below the snapshot does not reopen room until analytics agrees.
const RESERVE_ACCOUNT=`UPDATE ai_usage
SET used = used + ?1
WHERE day = ?2
  AND scope IN (?3, 'global')
  AND (SELECT COUNT(*) FROM ai_usage
       WHERE day = ?2 AND scope IN (?3, 'global')
         AND used + ?1 <= cap) = 2
  AND (
    SELECT CASE
      WHEN used > ?4 THEN used + ?1
      ELSE ?4 + ?1
    END
    FROM ai_usage WHERE day = ?2 AND scope = 'global'
  ) <= ?5
RETURNING scope, used`;
const REFUND_BOTH=`UPDATE ai_usage
SET used = used - ?1
WHERE day = ?2
  AND scope IN (?3, 'global')
  AND (SELECT COUNT(*) FROM ai_usage
       WHERE day = ?2 AND scope IN (?3, 'global')
         AND used >= ?1) = 2
RETURNING scope, used`;
const REFUND_ONE=`UPDATE ai_usage SET used = used - ?1
WHERE day = ?2 AND scope = ?3 AND used >= ?1`;
const ADD_ONE=`UPDATE ai_usage SET used = used + ?1 WHERE day = ?2 AND scope = ?3`;
const ADD_BOTH=`UPDATE ai_usage
SET used = used + ?1
WHERE day = ?2 AND scope IN (?3, 'global')
RETURNING scope, used`;

export function userScope(userId){return "user:"+userId;}
export function utcDay(now=Date.now()){
  const date=new Date(now);
  if(Number.isNaN(date.getTime()))return null;
  return date.toISOString().slice(0,10);
}
function validDay(day){
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  const parsed=Date.parse(day+"T00:00:00Z");
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===day;
}
function validUser(userId){
  return typeof userId==="string"&&userId.length>0&&userId.length<=80&&
    userId!==GLOBAL_SCOPE&&!/[\u0000-\u001f]/.test(userId);
}
function validEstimate(estimate){
  return Number.isSafeInteger(estimate)&&estimate>=1&&estimate<=USER_CAP;
}
async function readUpdate(db,sql,binds){
  const result=await db.prepare(sql).bind(...binds).all();
  if(!result||result.success===false||!Array.isArray(result.results))throw Error("quota");
  const changes=result.meta?.changes;
  if(typeof changes!=="number")throw Error("quota");
  return {rows:result.results,changes};
}
function scopesOf(rows){
  return new Set(rows.filter(row=>row&&typeof row.scope==="string").map(row=>row.scope));
}
function accepted(update,scope){
  const scopes=scopesOf(update.rows);
  return update.changes===2&&update.rows.length===2&&scopes.has(scope)&&scopes.has(GLOBAL_SCOPE);
}
async function undo(db,{day,estimate,scope,rows,changes}){
  const targets=new Set();
  for(const row of rows||[])if(row&&typeof row.scope==="string")targets.add(row.scope);
  // changes === 2 with no RETURNING rows still incremented both counters.
  if(changes===2&&targets.size===0){targets.add(scope);targets.add(GLOBAL_SCOPE);}
  for(const target of targets){
    try{await db.prepare(REFUND_ONE).bind(estimate,day,target).run();}catch{/* deny anyway */}
  }
}
async function insertCounter(db,scope,day,cap){
  const result=await db.prepare(INSERT).bind(scope,day,cap).run();
  if(!result||result.success===false)throw Error("quota");
}
function accountPredicate(snapshotLocal,accountCap){
  if(snapshotLocal===undefined&&accountCap===undefined)return null;
  if(!Number.isSafeInteger(snapshotLocal)||snapshotLocal<0)return false;
  if(!Number.isSafeInteger(accountCap))return false;
  return {snapshotLocal,accountCap};
}
const READ_SCOPE=`SELECT used, cap FROM ai_usage WHERE day = ?1 AND scope = ?2`;
const LOG_RESERVE=`INSERT INTO ai_usage_event(day, at_ms, amount) VALUES (?1, ?2, ?3)`;
async function noteReserve(db,day,amount){
  if(!Number.isSafeInteger(amount)||amount<1)throw Error("quota");
  const written=await db.prepare(LOG_RESERVE).bind(day,Date.now(),amount).run();
  if(!written||written.success===false||written.meta?.changes!==1)throw Error("quota");
}
function usageNumbers(row,fallbackCap){
  if(!row)return {used:0,cap:fallbackCap,remaining:fallbackCap};
  if(!Number.isSafeInteger(row.used)||row.used<0)return null;
  const cap=Number.isSafeInteger(row.cap)&&row.cap>=0?row.cap:fallbackCap;
  return {used:row.used,cap,remaining:row.used>=cap?0:cap-row.used};
}
export async function readOwnUsage(db,{userId,day,includeGlobal}={}){
  try{
    if(!db||typeof db.prepare!=="function")return {ok:false};
    if(!validUser(userId)||!validDay(day))return {ok:false};
    const row=await db.prepare(READ_SCOPE).bind(day,userScope(userId)).first();
    const own=usageNumbers(row,USER_CAP);
    if(!own)return {ok:false};
    const view={ok:true,day,used:own.used,cap:own.cap,remaining:own.remaining};
    if(!includeGlobal)return view;
    const globalRow=await db.prepare(READ_SCOPE).bind(day,GLOBAL_SCOPE).first();
    const shared=usageNumbers(globalRow,GLOBAL_CAP);
    if(!shared)return {ok:false};
    return {...view,global:{used:shared.used,cap:shared.cap,remaining:shared.remaining}};
  }catch{return {ok:false};}
}
export async function reserveQuota(db,{userId,day,estimate,snapshotLocal,accountCap}={}){
  const scope=userScope(userId);
  try{
    if(!db||typeof db.prepare!=="function")return {ok:false};
    if(!validUser(userId)||!validDay(day)||!validEstimate(estimate))return {ok:false};
    const account=accountPredicate(snapshotLocal,accountCap);
    if(account===false)return {ok:false};
    await insertCounter(db,scope,day,USER_CAP);
    await insertCounter(db,GLOBAL_SCOPE,day,GLOBAL_CAP);
    let update;
    try{
      update=account
        ?await readUpdate(db,RESERVE_ACCOUNT,[estimate,day,scope,account.snapshotLocal,account.accountCap])
        :await readUpdate(db,RESERVE,[estimate,day,scope]);
    }catch{return {ok:false};}
    if(accepted(update,scope)){
      try{await noteReserve(db,day,estimate);}
      catch{
        await undo(db,{day,estimate,scope,rows:update.rows,changes:update.changes});
        return {ok:false};
      }
      return {ok:true,estimate,scope,day};
    }
    await undo(db,{day,estimate,scope,rows:update.rows,changes:update.changes});
    return {ok:false};
  }catch{return {ok:false};}
}
export async function reconcileQuota(db,{userId,day,reserved,actual}){
  const scope=userScope(userId);
  try{
    if(!db||typeof db.prepare!=="function")return {ok:false};
    if(!validUser(userId)||!validDay(day)||!validEstimate(reserved))return {ok:false};
    // A failed call, or usage we cannot trust, keeps the reservation.
    // A safe integer above the old 100000 ceiling is still the full amount:
    // it is added with no cap check, and the next reserve then fails.
    if(actual==null)return {ok:true,action:"kept"};
    if(!Number.isSafeInteger(actual)||actual<=0)return {ok:true,action:"kept"};
    if(actual===reserved)return {ok:true,action:"same"};
    if(actual>reserved){
      const extra=actual-reserved;
      if(!Number.isSafeInteger(extra)||extra<1)return {ok:true,action:"kept"};
      // No cap predicate. Spent neurons stay on the counters even above the cap,
      // so the next reserve fails. Never undo this write.
      let update;
      try{update=await readUpdate(db,ADD_BOTH,[extra,day,scope]);}
      catch{return {ok:false,action:"kept"};}
      const scopes=scopesOf(update.rows);
      if((scopes.has(scope)&&scopes.has(GLOBAL_SCOPE))||(update.changes===2&&scopes.size===0)){
        await noteReserve(db,day,extra);
        return {ok:true,action:"increased"};
      }
      for(const target of [scope,GLOBAL_SCOPE]){
        if(scopes.has(target))continue;
        try{await db.prepare(ADD_ONE).bind(extra,day,target).run();}catch{/* keep the rows already increased */}
      }
      await noteReserve(db,day,extra);
      return {ok:true,action:"increased"};
    }
    const refund=reserved-actual;
    if(refund<1||refund>reserved)return {ok:false};
    let update;
    try{update=await readUpdate(db,REFUND_BOTH,[refund,day,scope]);}
    catch{return {ok:false,action:"kept"};}
    if(accepted(update,scope))return {ok:true,action:"refunded",refund};
    // A partial refund is not an error from D1. Put back exactly what came off.
    for(const row of update.rows){
      if(!row||typeof row.scope!=="string")continue;
      try{await db.prepare(ADD_ONE).bind(refund,day,row.scope).run();}catch{/* keep the reservation */}
    }
    return {ok:false,action:"kept"};
  }catch{return {ok:false};}
}
