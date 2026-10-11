// D1 does not support Supabase RLS. Every query MUST bind a verified user ID.
// This module intentionally exposes no generic query or arbitrary table access.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function verifiedUserId(userId) {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("Invalid verified user");
  return userId.toLowerCase();
}
function checkD1(db) {
  if (!db || typeof db.prepare !== "function") throw new Error("Staging D1 binding missing");
}
export async function activeMembership(db, userId) {
  checkD1(db);
  const id = verifiedUserId(userId);
  // Strict approval: missing membership is denied, even if a WHOOP connection exists.
  const member = await db.prepare(
    "SELECT m.user_id FROM whoop_members m INNER JOIN identity_links i ON i.user_id=m.user_id " +
    "WHERE m.user_id=?1 AND m.active=1 AND i.identity_provider='supabase' AND i.provider_subject=?1 LIMIT 1"
  ).bind(id).first();
  return !!member;
}
export async function connectionStatus(db, userId) {
  checkD1(db);
  const id = verifiedUserId(userId);
  const row = await db.prepare(
    "SELECT seat_role FROM whoop_connections WHERE user_id=?1 LIMIT 1"
  ).bind(id).first();
  return { connected: !!row };
}
const historyQueries = Object.freeze({
  recovery: "SELECT whoop_id,date,score,hrv,resting_heart_rate FROM whoop_recovery " +
    "WHERE user_id=?1 ORDER BY date DESC, whoop_id DESC LIMIT ?2",
  sleep: "SELECT whoop_id,start_time,end_time,performance_percentage,efficiency_percentage," +
    "total_sleep_seconds,rem_sleep_seconds,slow_wave_sleep_seconds FROM whoop_sleep " +
    "WHERE user_id=?1 ORDER BY start_time DESC, whoop_id DESC LIMIT ?2"
});
export async function readHistory(db, userId, category, limit=10) {
  checkD1(db);
  const id = verifiedUserId(userId);
  if (!Object.hasOwn(historyQueries, category)) throw new Error("Unsupported history category");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
    throw new Error("History limit out of range");
  const result = await db.prepare(historyQueries[category]).bind(id, limit).all();
  if (result.success === false || !Array.isArray(result.results))
    throw new Error("Staging read failed");
  return result.results;
}
