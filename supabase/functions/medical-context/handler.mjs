const cors={"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS","access-control-allow-headers":"authorization,content-type,apikey,x-client-info"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject=x=>!!x&&typeof x==="object"&&!Array.isArray(x);
const categories=new Set(["condition","medication","allergy","note"]);
const origins=new Set(["self_reported","provider_document"]);
const keys=new Set(["title","description","value","unit","status","dose","frequency","allergen","reaction"]);
function checkEntry(entry){
  if(!isObject(entry)||!categories.has(entry.category)||!origins.has(entry.source_type)||
    !isObject(entry.detail_json)||Object.keys(entry.detail_json).length<1||
    Object.keys(entry.detail_json).some(k=>!keys.has(k))||JSON.stringify(entry.detail_json).length>8000) return false;
  for(const v of Object.values(entry.detail_json))if(typeof v!=="string"||v.length>2000)return false;
  if(entry.source_label!=null&&(typeof entry.source_label!=="string"||entry.source_label.length>160))return false;
  if(entry.source_date!=null && (typeof entry.source_date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(entry.source_date)||!Number.isFinite(Date.parse(entry.source_date))))return false;
  return true;
}
export function createMedicalContextHandler({db,randomUUID=()=>crypto.randomUUID()}) {
  const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
  return async function handle(req){
    if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
    try{
      const token=req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if(!token)return respond({error:"Authentication required"},401);
      const {data:{user},error:authError}=await db.auth.getUser(token);
      if(authError||!user||!uuid.test(user.id))return respond({error:"Invalid session"},401);
      const {data:member,error:memberError}=await db.from("whoop_members").select("active").eq("user_id",user.id).maybeSingle();
      if(memberError)return respond({error:"Membership check failed"},500);
      if(member?.active!==true)return respond({error:member?"This account is disabled.":"WHOOP Lens membership required"},403); // strict allowlist
      const {data:connection,error:connectionError}=await db.from("whoop_connections").select("user_id").eq("user_id",user.id).maybeSingle();
      if(connectionError)return respond({error:"Connection check failed"},500);
      if(!connection)return respond({error:"WHOOP Lens access required"},403);
      const route=new URL(req.url);
      if(req.method==="GET"){
        const {data,error}=await db.from("medical_context_entries")
          .select("id,category,detail_json,source_type,source_label,source_date,reviewed_at,created_at,updated_at")
          .eq("user_id",user.id).order("created_at",{ascending:false}).limit(100);
        return error?respond({error:"Read failed"},500):respond({entries:data??[]});
      }
      if(!["POST","PATCH","DELETE"].includes(req.method))return respond({error:"Method not allowed"},405);
      if(Number(req.headers.get("content-length")??0)>16000)return respond({error:"Request too large"},413);
      const raw=await req.text();
      if(raw.length>16000)return respond({error:"Request too large"},413);
      let input;
      try{input=JSON.parse(raw)}catch{return respond({error:"Invalid JSON"},400)}
      if(!isObject(input)||input.approved!==true)return respond({error:"User approval required"},400);
      if(req.method==="POST"){
        if(!checkEntry(input))return respond({error:"Invalid entry"},400);
        const id=randomUUID();
        const {error}=await db.from("medical_context_entries").insert({
          id,user_id:user.id,category:input.category,detail_json:input.detail_json,
          source_type:input.source_type,source_label:input.source_label??null,
          source_date:input.source_date??null,reviewed_at:new Date().toISOString(),
        });
        return error?respond({error:"Save failed"},500):respond({saved:true,id});
      }
      const id=route.searchParams.get("id");
      if(!id||!uuid.test(id))return respond({error:"Valid entry ID required"},400);
      if(req.method==="PATCH"){
        if(!checkEntry(input))return respond({error:"Invalid entry"},400);
        const {data,error}=await db.from("medical_context_entries").update({
          category:input.category,detail_json:input.detail_json,source_type:input.source_type,
          source_label:input.source_label??null,source_date:input.source_date??null,
          reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString(),
        }).eq("user_id",user.id).eq("id",id).select("id").maybeSingle();
        if(error)return respond({error:"Update failed"},500);
        return data?respond({updated:true,id}):respond({error:"Entry not found"},404);
      }
      const {data,error}=await db.from("medical_context_entries").delete()
        .eq("user_id",user.id).eq("id",id).select("id").maybeSingle();
      if(error)return respond({error:"Delete failed"},500);
      return data?respond({deleted:true,id}):respond({error:"Entry not found"},404);
    }catch{return respond({error:"Request failed"},500)}
  }
}
