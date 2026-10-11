const headers = {
  "content-type": "application/json", "cache-control": "no-store",
  "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,apikey,x-client-info",
};
const legacyMetrics = new Set(["sleep","heart_rate","spo2","steps","activity","exercise","body_composition","skin_temperature","energy_score","blood_pressure","profile"]);
const metrics = new Map([
  ["steps_daily", {unit:"steps",keys:["count"]}],
  ["sleep_session",{unit:"seconds",keys:["duration_seconds"]}],
  ["heart_rate",{unit:"bpm",keys:["bpm"]}],
  ["exercise_session",{unit:"seconds",keys:["duration_seconds","exercise_type"]}],
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const dateValid = (v,now,ms=366*864e5) => typeof v === "string" &&
  Number.isFinite(Date.parse(v)) && Math.abs(Date.parse(v)-now)<ms;
const stable = v => Array.isArray(v) ? "["+v.map(stable).join(",")+"]" :
  isObject(v) ? "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}" : JSON.stringify(v);
async function hash(input) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
}
function timeOf(record) {
  for(const k of ["startTime","start_time","timestamp","time","endTime","end_time"]) {
    if(typeof record[k]==="string" && Number.isFinite(Date.parse(record[k]))) return new Date(record[k]).toISOString();
  }
  return null;
}
export function validateHealthConnect(batch,now=Date.now()) {
  if(!isObject(batch) || batch.schema_version!==2 || batch.source!=="health_connect" ||
     !dateValid(batch.exported_at,now) || !Array.isArray(batch.records) || batch.records.length>100)
    return {error:"Unsupported Health Connect export"};
  const rows=[];
  for(const item of batch.records) {
    if(!isObject(item)||!metrics.has(item.metric)) return {error:"Invalid Health Connect record"};
    const def=metrics.get(item.metric);
    if(typeof item.record_key!=="string"||item.record_key.length>128||!/^[-\w:.+]{1,128}$/.test(item.record_key)||
       !dateValid(item.observed_at,now) || (item.ended_at!=null && (!dateValid(item.ended_at,now) || Date.parse(item.ended_at)<Date.parse(item.observed_at))) ||
       (item.local_date!=null && (typeof item.local_date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(item.local_date))) ||
       (item.origin_package!=null && (typeof item.origin_package!=="string" || item.origin_package.length>160 || !/^[a-zA-Z0-9_.]+$/.test(item.origin_package))) ||
       item.unit!==def.unit || !isObject(item.payload) ||
       Object.keys(item.payload).some(k=>!def.keys.includes(k)) || !def.keys.every(k=>Object.hasOwn(item.payload,k))) return {error:"Invalid Health Connect record"};
    for(const key of def.keys){
      const value=item.payload[key];
      if(key==="exercise_type") {
        if(typeof value!=="string"||value.length<1||value.length>80) return {error:"Invalid Health Connect record"};
      } else if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>1e7||
        ((key==="count"||key==="bpm")&&!Number.isInteger(value))) return {error:"Invalid Health Connect record"};
    }
    rows.push({
      metric:item.metric,record_key:item.record_key,origin_package:item.origin_package??null,
      observed_at:new Date(item.observed_at).toISOString(),
      ended_at:item.ended_at?new Date(item.ended_at).toISOString():null,
      local_date:item.local_date??null,unit:item.unit,payload:item.payload
    });
  }
  return {rows};
}
export function createSamsungHealthHandler({db,now=()=>Date.now()}) {
  const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  return async function handle(req) {
    if(req.method==="OPTIONS") return new Response("ok",{headers});
    try {
      const token=req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if(!token) return respond({error:"Authentication required"},401);
      const {data:{user},error:authError}=await db.auth.getUser(token);
      if(authError||!user||!uuid.test(user.id)) return respond({error:"Invalid session"},401);
      const {data:member,error:memberError}=await db.from("whoop_members").select("active").eq("user_id",user.id).maybeSingle();
      if(memberError) return respond({error:"Membership check failed"},500);
      if(member && member.active===false) return respond({error:"This account is disabled."},403);
      const {data:connection,error:connectionError}=await db.from("whoop_connections").select("user_id").eq("user_id",user.id).maybeSingle();
      if(connectionError) return respond({error:"Connection check failed"},500);
      if(!connection) return respond({error:"WHOOP Lens access required"},403);
      const route=new URL(req.url);
      if(req.method==="GET") {
        const metric=route.searchParams.get("metric");
        if(metric&&!legacyMetrics.has(metric)) return respond({error:"Unknown metric"},400);
        const limit=Math.min(100,Math.max(1,Number(route.searchParams.get("limit")??25)||25));
        let query=db.from("samsung_health_records").select("metric,source,transport,observed_at,exported_at,sdk_record,inserted_at")
          .eq("user_id",user.id).order("inserted_at",{ascending:false}).limit(limit);
        if(metric)query=query.eq("metric",metric);
        const {data,error}=await query;
        if(error)return respond({error:"Read failed"},500);
        return respond({records:data,limit});
      }
      if(req.method!=="POST"&&req.method!=="DELETE") return respond({error:"Method not allowed"},405);
      if(Number(req.headers.get("content-length")??0)>512000) return respond({error:"Batch too large"},413);
      const raw=await req.text();
      if(raw.length>512000)return respond({error:"Batch too large"},413);
      let payload;
      try{payload=JSON.parse(raw)}catch{return respond({error:"Invalid JSON"},400)}
      if(req.method==="DELETE") {
        if(!isObject(payload)||payload.schema_version!==2||payload.source!=="health_connect"||
          payload.approved!==true||!metrics.has(payload.metric)||
          typeof payload.record_key!=="string"||
          !/^[-\\w:.+]{1,128}$/.test(payload.record_key))
          return respond({error:"Invalid approved Health Connect deletion"},400);
        const {data,error}=await db.from("health_connect_records").delete()
          .eq("user_id",user.id).eq("metric",payload.metric)
          .eq("record_key",payload.record_key).select("id");
        if(error)return respond({error:"Delete failed"},500);
        return respond({deleted:(data??[]).length,schema_version:2});
      }
      if(payload?.schema_version===2) {
        const validated=validateHealthConnect(payload,now());
        if(validated.error)return respond({error:validated.error},400);
        if(!validated.rows.length)return respond({accepted:0,schema_version:2});
        const rows=validated.rows.map(row=>({...row,user_id:user.id}));
        const {error}=await db.from("health_connect_records").upsert(rows,{onConflict:"user_id,metric,record_key"});
        if(error)return respond({error:"Upload failed"},500);
        return respond({accepted:rows.length,schema_version:2});
      }
      if(!isObject(payload)||payload.schema_version!==1||payload.source!=="samsung_health"||
        payload.transport!=="samsung_health_data_sdk"||!dateValid(payload.exported_at,now()))
        return respond({error:"Unsupported export"},400);
      if(!Array.isArray(payload.records)||payload.records.length>100)
        return respond({error:"Send up to 100 records per batch"},400);
      const rows=[];
      for(const item of payload.records){
        if(!isObject(item)||!legacyMetrics.has(item.metric)||item.source!=="samsung_health"||
          item.transport!=="samsung_health_data_sdk"||!isObject(item.sdk_record))
          return respond({error:"Invalid record"},400);
        const record=item.sdk_record;
        if(stable(record).length>30000)return respond({error:"Record too large"},413);
        rows.push({user_id:user.id,metric:item.metric,source:"samsung_health",transport:"samsung_health_data_sdk",
          source_record_hash:await hash(item.metric+":"+stable(record)),observed_at:timeOf(record),
          exported_at:payload.exported_at,sdk_record:record});
      }
      if(!rows.length)return respond({accepted:0});
      const {error}=await db.from("samsung_health_records").upsert(rows,{onConflict:"user_id,metric,source_record_hash",ignoreDuplicates:true});
      if(error)return respond({error:"Upload failed"},500);
      return respond({accepted:rows.length});
    } catch {
      return respond({error:"Request failed"},500);
    }
  };
}
