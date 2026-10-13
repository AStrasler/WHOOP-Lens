// Local record reads never accept an owner from the client. Membership is checked
// by the router before dispatch; each SQL statement also binds the verified ID.
import manifest from '../../supabase/functions/whoop-mcp/capabilities.json' with {type:'json'};
import {activeMembership,connectionStatus} from './storage.mjs';
import {ISSUE_CONSENT,REVOKE_CONFIRM} from './health-connect-webhook.mjs';
export const SAMSUNG_METRICS=['sleep','heart_rate','spo2','steps','activity','exercise','body_composition','skin_temperature','energy_score','blood_pressure','profile'];
export const HC_METRICS=['steps_daily','sleep_session','heart_rate','exercise_session'];
const categories=['whoop','optional','explore','advocacy','planned','unsupported'];
const paging={limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:100000}};
const definitions=[
  ['get_samsung_health','Read the signed-in account’s uploaded Samsung Health records, separately attributed from WHOOP.',{...paging,metric:{type:'string',enum:SAMSUNG_METRICS}}],
  ['get_health_connect','Read the signed-in account’s stored Health Connect records from a file import or phone ingest. This tool does not sync a phone.',{...paging,metric:{type:'string',enum:HC_METRICS}}],
  ['get_medical_context','Read only explicitly reviewed, source-labeled medical context belonging to the signed-in account.',paging],
  ['get_capabilities','Describe registered tools, account data availability and limitations.',{
    category:{type:'string',enum:categories},limit:{type:'integer',minimum:1,maximum:25},
    offset:{type:'integer',minimum:0,maximum:1000},include_planned:{type:'boolean'}}],
  ['connect_whoop','Create a short-lived WHOOP consent link for the signed-in account. Requires user completion.',{}],
  ['disconnect_whoop','Delete only this account’s stored WHOOP credentials on WHOOP Lens. The WHOOP account itself is unchanged.',{}],
  ['import_health_connect_file','Store a user-selected WHOOP Lens Health Connect v2 JSON file for the signed-in account. This is a file import, not a live Health Connect sync.',{
    consent:{type:'string',enum:['store-health-connect-file']},
    file_json:{type:'string',minLength:2,maxLength:400000}}],
  ['withdraw_health_connect_import','Delete stored Health Connect records for the signed-in account, record consent withdrawal, and revoke phone ingest tokens.',{
    confirm:{type:'string',enum:['delete-my-health-connect-records']}}],
  ['issue_health_connect_ingest_token','Issue this account’s Health Connect webhook token. Replaces any current token, grants storage consent, and shows the secret once.',{
    consent:{type:'string',enum:[ISSUE_CONSENT]}}],
  ['revoke_health_connect_ingest_token','Revoke this account’s Health Connect webhook tokens. Stored records remain until withdrawal.',{
    confirm:{type:'string',enum:[REVOKE_CONFIRM]}}]
];
const accountWrites=new Set(['connect_whoop','disconnect_whoop','import_health_connect_file','withdraw_health_connect_import','issue_health_connect_ingest_token','revoke_health_connect_ingest_token']);
export const extraTools=definitions.map(([name,description,properties])=>({name,description,
  inputSchema:{type:'object',properties,additionalProperties:false},
  annotations:{
    readOnlyHint:!accountWrites.has(name),
    destructiveHint:name==='disconnect_whoop'||name==='withdraw_health_connect_import'||name==='revoke_health_connect_ingest_token',
    openWorldHint:name==='connect_whoop'
  }}));
export function extraArguments(name,args){
  const tool=extraTools.find(t=>t.name===name);
  if(!tool||!args||typeof args!=='object'||Array.isArray(args))return null;
  const schema=tool.inputSchema.properties;
  if(Object.keys(args).some(k=>!Object.hasOwn(schema,k)))return null;
  for(const [key,value] of Object.entries(args)){
    const rule=schema[key];
    if(rule.type==='integer'&&(!Number.isSafeInteger(value)||value<rule.minimum||value>rule.maximum))return null;
    if(rule.type==='boolean'&&typeof value!=='boolean')return null;
    if(rule.enum&&!rule.enum.includes(value))return null;
  }
  if(name==='connect_whoop'||name==='disconnect_whoop')return {};
  if(name==='withdraw_health_connect_import')
    return args.confirm==='delete-my-health-connect-records'?{confirm:args.confirm}:null;
  if(name==='issue_health_connect_ingest_token')
    return args.consent===ISSUE_CONSENT?{consent:args.consent}:null;
  if(name==='revoke_health_connect_ingest_token')
    return args.confirm===REVOKE_CONFIRM?{confirm:args.confirm}:null;
  if(name==='import_health_connect_file'){
    if(args.consent!=='store-health-connect-file'||typeof args.file_json!=='string'||
       args.file_json.length<2||args.file_json.length>400000)return null;
    return {consent:args.consent,file_json:args.file_json};
  }
  return {limit:25,offset:0,...args};
}
async function rows(db,sql,args){
  const result=await db.prepare(sql).bind(...args).all();
  if(result.success===false||!Array.isArray(result.results))throw Error('Record read unavailable');
  return result.results;
}
export async function readExtraTool(db,userId,name,args){
  if(!await activeMembership(db,userId))throw Error('Not authorized');
  if(extraArguments(name,args)===null)throw Error('Invalid arguments');
  if(name==='get_capabilities')return catalog(db,userId,args);
  const {limit=25,offset=0,metric}=args;
  const filter=metric===undefined?'':' AND metric=?4';
  let sql;
  if(name==='get_samsung_health')sql='SELECT metric,source,transport,observed_at,exported_at,sdk_record_json,inserted_at FROM samsung_health_records WHERE user_id=?1'+filter+' ORDER BY inserted_at DESC,id DESC LIMIT ?2 OFFSET ?3';
  else if(name==='get_health_connect')sql='SELECT metric,record_key,origin_package,observed_at,ended_at,local_date,unit,payload_json,created_at,updated_at FROM health_connect_records WHERE user_id=?1'+filter+' ORDER BY observed_at DESC,record_key DESC LIMIT ?2 OFFSET ?3';
  else if(name==='get_medical_context')sql='SELECT id,category,detail_json,source_type,source_label,source_date,reviewed_at,created_at,updated_at FROM medical_context WHERE user_id=?1 AND reviewed_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3';
  else throw Error('Unsupported tool');
  const data=await rows(db,sql,[userId,limit+1,offset,...(metric===undefined?[]:[metric])]);
  const records=data.slice(0,limit).map(row=>{
    const result={...row};
    for(const [column,target] of [['sdk_record_json','sdk_record'],['payload_json','payload'],['detail_json','detail_json']]){
      if(Object.hasOwn(result,column)){
        const value=JSON.parse(result[column]);delete result[column];result[target]=value;
      }
    }
    return result;
  });
  const next_offset=data.length>limit?offset+limit:null;
  if(name==='get_medical_context')return {entries:records,next_offset,provenance:'user_approved_medical_context'};
  return {records,next_offset,source:name==='get_samsung_health'?'samsung_health':'health_connect',
    transport:name==='get_samsung_health'?'samsung_health_data_sdk':'stored_health_connect'};
}
async function catalog(db,userId,{category,limit=25,offset=0,include_planned=true}){
  const connected=(await connectionStatus(db,userId)).connected;
  const available={};
  for(const [id,sql] of Object.entries({
    samsung:'SELECT id FROM samsung_health_records WHERE user_id=?1 LIMIT 1',
    'health-connect':'SELECT id FROM health_connect_records WHERE user_id=?1 LIMIT 1',
    'medical-context':'SELECT id FROM medical_context WHERE user_id=?1 AND reviewed_at IS NOT NULL LIMIT 1'
  }))available[id]=!!await db.prepare(sql).bind(userId).first();
  const localTools={'samsung':'get_samsung_health','health-connect':'get_health_connect','medical-context':'get_medical_context'};
  const capabilities=manifest.capabilities.map(item=>{
    let value={...item};
    if(localTools[item.id]){
      const health=item.id==='health-connect';
      return {...value,category:'optional',delivery:'mcp_tool',
        name:health?'Health Connect records':value.name,
        description:health?'Reads Health Connect records stored for this account from a file import or phone ingest.':value.description,
        tools:[localTools[item.id]],status:available[item.id]?'available':'requires_connection_or_data',
        provides:health?'Reads stored Health Connect records. Phone ingest requires its own token and server flag.':'Reads existing authorized records; does not import or sync new data.',
        data_requirements:health?['A stored file import, or an issued phone ingest token while that server flag is on.']:value.data_requirements,
        limitations:['Records are source-labeled and account-scoped. Phone ingest stays off until a token is issued and the server flag is on.'],
        availability_reason:available[item.id]?'Authorized records exist.':'No authorized records are present for this account.'};
    }
    const needsWhoop=item.tools.some(t=>['get_profile','get_body_measurements','get_recovery','get_sleep','get_workouts','get_cycles'].includes(t));
    return {...value,status:needsWhoop&&!connected?'requires_connection_or_data':item.status,
      availability_reason:needsWhoop&&!connected?'Connect WHOOP first.':
        item.delivery==='host_assisted'?'Depends on the AI host and sufficient user-provided or connected data.':
        item.status==='planned'||item.status==='unsupported'?'Not provided by this service.':'Registered; record completeness is not guaranteed.'};
  }).filter(item=>(!category||item.category===category)&&(include_planned||!['planned','unsupported'].includes(item.status)));
  return {schema_version:manifest.schema_version,registry_version:'cloudflare-1.2',source:'bundled_cloudflare_catalog',
    global_limitations:[...manifest.global_limitations.filter(s=>!s.startsWith('Android Health Connect')),
      'Local record tools read stored records for the signed-in account.',
      'Health Connect phone ingest stays off until an ingest token is issued and the server flag is on. File import is a separate consent.'],
    total:capabilities.length,next_offset:offset+limit<capabilities.length?offset+limit:null,
    capabilities:capabilities.slice(offset,offset+limit)};
}
