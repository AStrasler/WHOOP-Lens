// WhoopLens seat cap: how many members may hold a WHOOP connection at once.
// Every connection counts, the owner/developer seat included, so the default
// of 3 means the owner plus two approved members. Raise it to admit more,
// after approving them through the seat-request workflow (auth Worker,
// migration 0014) and activating their whoop_members row; nothing expands it
// automatically and there is no self-registration.
//   WHOOP_LENS_SEAT_LIMIT  integer 1-10, default 3
// The database triggers from migration 0002 (9 public + 1 developer) stay in
// place as a hard ceiling, so values above 10 are clamped to 10. A missing or
// invalid value uses the default (never a larger cap).
// A member who already holds a connection can always reconnect; the cap only
// stops new connections, and it is checked in the same statement that writes
// the connection, so concurrent callbacks cannot overshoot it.
export const DEFAULT_SEAT_LIMIT=3;
export const SEAT_LIMIT_CEILING=10;
let warned=false;
export function seatLimit(env){
  const raw=env?.WHOOP_LENS_SEAT_LIMIT;
  if(raw==null||raw==="")return DEFAULT_SEAT_LIMIT;
  const text=String(raw).trim();
  if(!/^[1-9][0-9]*$/.test(text)){
    if(!warned){warned=true;console.log(JSON.stringify({event:"seat_limit",outcome:"invalid_config_default_used"}));}
    return DEFAULT_SEAT_LIMIT;
  }
  return Math.min(Number(text),SEAT_LIMIT_CEILING);
}
export class SeatsFull extends Error{
  constructor(limit){
    super(`All ${limit} WhoopLens seats are in use. New seats are granted only by the owner after a seat request.`);
    this.name="SeatsFull";this.status=409;this.limit=limit;
  }
}
// SQL condition (for ?1 = member id, cap bound at the given placeholder):
// the member already has a connection, or fewer than cap connections exist.
export function seatAvailableSql(placeholder){
  return "(EXISTS (SELECT 1 FROM whoop_connections WHERE user_id=?1) OR "+
    "(SELECT COUNT(*) FROM whoop_connections)<"+placeholder+")";
}
export async function assertSeatAvailable(db,id,env){
  const limit=seatLimit(env);
  const row=await db.prepare("SELECT "+seatAvailableSql("?2")+" AS ok").bind(id,limit).first();
  if(!row||Number(row.ok)!==1)throw new SeatsFull(limit);
  return limit;
}
