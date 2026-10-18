// Per-member WHOOP request budget. WHOOP limits the whole app (100 requests a
// minute, 10,000 a day by default), so one busy member could otherwise slow
// every member down. Each outbound WHOOP API request first reserves one unit
// for the authenticated member; over budget, no WHOOP request is made and a
// MemberRateLimited error (status 429, retryAfter seconds) is thrown, which the
// MCP and REST layers already report as a rate limit (auto_page keeps the
// records it has and returns a cursor).
//
// Defaults: 25 a minute and 1,000 a day per member. Ten seats (9 public + 1
// developer) x 1,000 = WHOOP's 10,000 a day, so the daily share is strict. The
// minute share is 2.5x the strict 10, because one summary with baselines uses
// about 18 requests and an auto_page call 4; four members at full speed still
// fit in WHOOP's 100 a minute. Configuration (Worker vars, all optional):
//   WHOOP_MEMBER_LIMIT_ENABLED        "false" turns enforcement off (default on)
//   WHOOP_MEMBER_LIMIT_PER_MINUTE     default 25
//   WHOOP_MEMBER_LIMIT_PER_DAY        default 1000
//   WHOOP_DEVELOPER_LIMIT_PER_MINUTE  developer seat; default = member value
//   WHOOP_DEVELOPER_LIMIT_PER_DAY     developer seat; default = member value
// The developer seat is the member whose whoop_connections.seat_role is
// 'developer' (read inside the same reservation statement, so no extra query
// and no dependency on WHOOP_LENS_DEVELOPER_USER_ID). It is not exempt by default. Values are
// whole numbers clamped to WHOOP's app limits; a missing, zero or malformed
// value uses the default, so a typo can never lock members out.
// Token refreshes (WHOOP's OAuth endpoint) are not counted.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WHOOP_APP_LIMITS=Object.freeze({perMinute:100,perDay:10000});
export const DEFAULT_MEMBER_LIMITS=Object.freeze({perMinute:25,perDay:1000});
const MINUTE_MS=60_000,DAY_MS=86_400_000;

export class MemberRateLimited extends Error{
  constructor(retryAfter,window,limit){
    super("WHOOP Lens member request limit reached");
    this.status=429;this.memberLimit=true;this.retryAfter=retryAfter;this.window=window;this.limit=limit;
  }
}
function whole(raw,fallback,max){
  if(raw==null)return fallback;
  const text=String(raw).trim();
  if(!/^\d{1,6}$/.test(text))return fallback;
  const value=Number(text);
  return value>=1?Math.min(value,max):fallback;
}
// Limits for both seat kinds; the reservation picks one by seat_role.
export function memberLimits(env){
  const perMinute=whole(env?.WHOOP_MEMBER_LIMIT_PER_MINUTE,DEFAULT_MEMBER_LIMITS.perMinute,WHOOP_APP_LIMITS.perMinute);
  const perDay=whole(env?.WHOOP_MEMBER_LIMIT_PER_DAY,DEFAULT_MEMBER_LIMITS.perDay,WHOOP_APP_LIMITS.perDay);
  return {
    public:{perMinute,perDay},
    developer:{
      perMinute:whole(env?.WHOOP_DEVELOPER_LIMIT_PER_MINUTE,perMinute,WHOOP_APP_LIMITS.perMinute),
      perDay:whole(env?.WHOOP_DEVELOPER_LIMIT_PER_DAY,perDay,WHOOP_APP_LIMITS.perDay)
    }
  };
}
export function memberLimitEnabled(env){return env?.WHOOP_MEMBER_LIMIT_ENABLED!=="false";}
// One statement: reset a counter when its window has passed, then add one
// unit only if both windows have room. SQLite serialises writers, so parallel
// requests for one member cannot both take the last unit. A window behind the
// stored one (a Worker with a slower clock) counts in the stored window.
// ?4/?5 are the public limits and ?6/?7 the developer-seat limits; lim picks
// one by the member's seat_role (no connection row = public).
const LIMIT_MINUTE="(CASE WHEN (SELECT seat_role FROM whoop_connections WHERE user_id=?1)='developer' THEN ?6 ELSE ?4 END)";
const LIMIT_DAY="(CASE WHEN (SELECT seat_role FROM whoop_connections WHERE user_id=?1)='developer' THEN ?7 ELSE ?5 END)";
const RESERVE=
  "INSERT INTO whoop_member_request_budget(user_id,minute_start,minute_count,day_start,day_count) "+
  "SELECT ?1,?2,1,?3,1 WHERE "+LIMIT_MINUTE+">=1 AND "+LIMIT_DAY+">=1 "+
  "ON CONFLICT(user_id) DO UPDATE SET "+
  "minute_count=CASE WHEN excluded.minute_start>whoop_member_request_budget.minute_start THEN 1 ELSE whoop_member_request_budget.minute_count+1 END,"+
  "minute_start=MAX(whoop_member_request_budget.minute_start,excluded.minute_start),"+
  "day_count=CASE WHEN excluded.day_start>whoop_member_request_budget.day_start THEN 1 ELSE whoop_member_request_budget.day_count+1 END,"+
  "day_start=MAX(whoop_member_request_budget.day_start,excluded.day_start),"+
  "updated_at=CURRENT_TIMESTAMP "+
  "WHERE (excluded.minute_start>whoop_member_request_budget.minute_start OR whoop_member_request_budget.minute_count<"+LIMIT_MINUTE+") "+
  "AND (excluded.day_start>whoop_member_request_budget.day_start OR whoop_member_request_budget.day_count<"+LIMIT_DAY+") "+
  "RETURNING minute_count,day_count";
export function missingTable(error,table){
  const text=String(error?.message||error||"");
  return /no such table/i.test(text)&&text.includes(table);
}
let schemaWarned=false;
export async function reserveWhoopRequest(db,userId,env,{now=Date.now}={}){
  if(!memberLimitEnabled(env))return {enforced:false};
  if(typeof userId!=="string"||!UUID.test(userId))throw Error("Invalid user");
  const id=userId.toLowerCase(),both=memberLimits(env);
  const at=now(),minute=Math.floor(at/MINUTE_MS),day=Math.floor(at/DAY_MS);
  let row;
  try{
    row=await db.prepare(RESERVE).bind(id,minute,day,both.public.perMinute,both.public.perDay,
      both.developer.perMinute,both.developer.perDay).first();
  }catch(error){
    // Code deployed before migration 0015 is applied (or after its rollback)
    // keeps serving with WHOOP's own limit only. Any other D1 error fails closed.
    if(!missingTable(error,"whoop_member_request_budget"))throw error;
    if(!schemaWarned){schemaWarned=true;console.log(JSON.stringify({event:"member_rate_limit",outcome:"schema_missing"}));}
    return {enforced:false};
  }
  if(row)return {enforced:true,minute:row.minute_count,day:row.day_count};
  const current=await db.prepare(
    "SELECT b.minute_start,b.minute_count,b.day_start,b.day_count,"+
    "(SELECT seat_role FROM whoop_connections WHERE user_id=?1) AS seat_role "+
    "FROM whoop_member_request_budget b WHERE b.user_id=?1 LIMIT 1"
  ).bind(id).first();
  const seat=current?.seat_role==="developer"?"developer":"public",limits=both[seat];
  const dayFull=!!current&&Number(current.day_start)>=day&&Number(current.day_count)>=limits.perDay;
  const resetAt=dayFull?(Math.max(day,Number(current.day_start))+1)*DAY_MS:
    (Math.max(minute,Number(current?.minute_start)||0)+1)*MINUTE_MS;
  const retryAfter=Math.min(DAY_MS/1000,Math.max(1,Math.ceil((resetAt-at)/1000)));
  console.log(JSON.stringify({event:"member_rate_limit",outcome:"limited",window:dayFull?"day":"minute",seat}));
  throw new MemberRateLimited(retryAfter,dayFull?"day":"minute",dayFull?limits.perDay:limits.perMinute);
}
export function memberLimitMessage(error){
  const wait=Number.isSafeInteger(error?.retryAfter)?Math.max(1,error.retryAfter):60;
  const per=error?.window==="day"?"day (UTC)":"minute";
  return `This account reached its WHOOP Lens request limit (${error?.limit??"the configured number of"} WHOOP requests per ${per}). `+
    `No WHOOP request was made. Wait about ${wait} seconds, then retry the same call. Any next_token you hold stays valid for up to one hour.`;
}
