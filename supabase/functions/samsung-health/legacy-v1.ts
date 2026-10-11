import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,apikey,x-client-info" };
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const metrics = new Set(["sleep", "heart_rate", "spo2", "steps", "activity", "exercise", "body_composition", "skin_temperature", "energy_score", "blood_pressure", "profile"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validDate = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s)) && Math.abs(Date.parse(s) - Date.now()) < 366 * 24 * 3600_000;
const stable = (v: unknown): string => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable((v as Record<string,unknown>)[k])).join(",") + "}" : JSON.stringify(v);
async function sha(input: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2,"0")).join(""); }
function timeOf(record: Record<string, unknown>) {
  for (const k of ["startTime", "start_time", "timestamp", "time", "endTime", "end_time"]) {
    const value = record[k];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers});
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return respond({error:"Authentication required"},401);
    const {data:{user},error:authError} = await db.auth.getUser(token);
    if (authError || !user || !uuid.test(user.id)) return respond({error:"Invalid session"},401);
    const {data:connection,error:connectionError} = await db.from("whoop_connections").select("user_id").eq("user_id",user.id).maybeSingle();
    if (connectionError) return respond({error:"Connection check failed"},500);
    if (!connection) return respond({error:"WHOOP Lens access required"},403);
    const route = new URL(req.url);
    if (req.method === "GET") {
      const metric = route.searchParams.get("metric");
      if (metric && !metrics.has(metric)) return respond({error:"Unknown metric"},400);
      const limit = Math.min(100,Math.max(1,Number(route.searchParams.get("limit") ?? 25) || 25));
      let query = db.from("samsung_health_records").select("metric,source,transport,observed_at,exported_at,sdk_record,inserted_at")
        .eq("user_id",user.id).order("inserted_at",{ascending:false}).limit(limit);
      if (metric) query = query.eq("metric",metric);
      const {data,error} = await query;
      if (error) return respond({error:"Read failed"},500);
      return respond({records:data,limit});
    }
    if (req.method !== "POST") return respond({error:"Method not allowed"},405);
    if (Number(req.headers.get("content-length") ?? 0) > 512_000) return respond({error:"Batch too large"},413);
    const raw = await req.text();
    if (raw.length > 512_000) return respond({error:"Batch too large"},413);
    let payload: Record<string,unknown>;
    try { payload = JSON.parse(raw); } catch { return respond({error:"Invalid JSON"},400); }
    if (payload.schema_version !== 1 || payload.source !== "samsung_health" || payload.transport !== "samsung_health_data_sdk" || !validDate(payload.exported_at)) return respond({error:"Unsupported export"},400);
    if (!Array.isArray(payload.records) || payload.records.length > 100) return respond({error:"Send up to 100 records per batch"},400);
    const rows = [];
    for (const item of payload.records) {
      if (!item || typeof item !== "object" || !metrics.has(item.metric) || item.source !== "samsung_health" || item.transport !== "samsung_health_data_sdk" || !item.sdk_record || typeof item.sdk_record !== "object" || Array.isArray(item.sdk_record)) return respond({error:"Invalid record"},400);
      const record = item.sdk_record as Record<string,unknown>;
      if (stable(record).length > 30_000) return respond({error:"Record too large"},413);
      rows.push({user_id:user.id,metric:item.metric,source:"samsung_health",transport:"samsung_health_data_sdk",source_record_hash:await sha(item.metric + ":" + stable(record)),observed_at:timeOf(record),exported_at:payload.exported_at,sdk_record:record});
    }
    if (rows.length === 0) return respond({accepted:0});
    const {error} = await db.from("samsung_health_records").upsert(rows,{onConflict:"user_id,metric,source_record_hash",ignoreDuplicates:true});
    if (error) return respond({error:"Upload failed"},500);
    return respond({accepted:rows.length});
  } catch { return respond({error:"Request failed"},500); }
});
