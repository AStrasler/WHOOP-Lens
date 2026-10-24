// Local record reads never accept an owner from the client. Membership is checked
// by the router before dispatch; each SQL statement also binds the verified ID.
import manifest from './capabilities.json' with {type:'json'};
import {activeMembership} from './storage.mjs';
import {ISSUE_CONSENT,REVOKE_CONFIRM} from './health-connect-webhook.mjs';
import {featureStates,accountStatus,SOURCE_HIERARCHY} from './member-guidance.mjs';
export const SAMSUNG_METRICS=['sleep','heart_rate','spo2','steps','activity','exercise','body_composition','skin_temperature','energy_score','blood_pressure','profile'];
export const HC_METRICS=['steps_daily','sleep_session','heart_rate','exercise_session'];
const categories=['whoop','optional','explore','advocacy','planned','unsupported'];
const paging={limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:100000}};
const definitions=[
  ['get_samsung_health','Read the signed-in account’s uploaded Samsung Health records, separately attributed from WHOOP. Supplementary: cite them as Samsung Health, never as WHOOP data or a substitute for missing WHOOP measurements.',{...paging,metric:{type:'string',enum:SAMSUNG_METRICS}}],
  ['get_health_connect','Read the signed-in account’s stored Health Connect records from a file import or phone ingest. This tool does not sync a phone. Supplementary: cite them as Health Connect, never as WHOOP data or a substitute for missing WHOOP measurements.',{...paging,metric:{type:'string',enum:HC_METRICS}}],
  ['get_medical_context','Read only explicitly reviewed, source-labeled medical context belonging to the signed-in account. Use only when the user asks for it; never as a substitute for WHOOP measurements.',paging],
  ['get_capabilities','Describe registered tools, server feature states (enabled, disabled, not configured), this account\'s seat role and data status, and limitations.',{
    category:{type:'string',enum:categories},limit:{type:'integer',minimum:1,maximum:25},
    offset:{type:'integer',minimum:0,maximum:1000},include_planned:{type:'boolean'}}],
  ['connect_whoop','Create a short-lived WHOOP consent link for the signed-in account. Requires user completion.',{}],
  ['disconnect_whoop','Delete only this account’s stored WHOOP credentials on WHOOP Lens. The WHOOP account itself is unchanged.',{}],
  ['import_health_connect_file','Store a user-selected WHOOP Lens Health Connect v2 JSON file for the signed-in account. This is a file import, not a live Health Connect sync.',{
    consent:{type:'string',enum:['store-health-connect-file']},
    file_json:{type:'string',minLength:2,maxLength:400000}}],
  ['withdraw_health_connect_import','Delete stored Health Connect records for the signed-in account, record consent withdrawal, and revoke phone ingest tokens.',{
    confirm:{type:'string',enum:['delete-my-health-connect-records']}}],
  ['issue_health_connect_ingest_token','Issue this account’s Health Connect webhook token. Replaces any current token, grants storage consent, and shows the secret once. Issuing a token does not mean data has arrived; records appear only after the phone app delivers them.',{
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
// Optional capabilities are advertised only when their exact feature flag is enabled.
export async function readExtraTool(db,userId,name,args,env=null){
  if(!await activeMembership(db,userId))throw Error('Not authorized');
  if(extraArguments(name,args)===null)throw Error('Invalid arguments');
  if(name==='get_capabilities')return catalog(db,userId,args,env);
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
  if(name==='get_medical_context')return {entries:records,next_offset,provenance:'user_approved_medical_context',source_authority:'user_directed'};
  return {records,next_offset,source:name==='get_samsung_health'?'samsung_health':'health_connect',source_authority:'supplementary',
    transport:name==='get_samsung_health'?'samsung_health_data_sdk':'stored_health_connect'};
}
// Listed only when STRESS_ESTIMATE_ENABLED and AI_SUMMARY_ENABLED are both exactly "true". The Stress Monitor
// entries from the manifest stay unsupported either way.
export const STRESS_CAPABILITY=Object.freeze({
  id:'experimental-stress-estimate',name:'WHOOP Lens experimental physiological stress estimate',category:'explore',
  delivery:'mcp_tool',tools:['get_recovery'],status:'available',
  description:"An experimental daily 0-100 index derived from the user's own HRV, resting heart rate, sleep and respiratory rate against that user's prior 30 days. Not WHOOP's Stress Monitor. Not clinically validated.",
  provides:'chart_data.stress_estimate on get_recovery summaries, with value, band, confidence, contributing measurements and limitations.',
  data_requirements:['A WHOOP connection with at least 14 scored recovery days in the 30 days before each estimated day.'],
  limitations:["Not WHOOP's Stress Monitor and not clinically validated; not a diagnosis.",
    'Does not provide Stress Monitor zone durations, non-activity high stress, or an intraday timeline.',
    'One value per day from daily WHOOP scores; it does not identify a cause.'],
  example_prompts:['What was my experimental stress estimate this week, and how confident is it?']
});
async function catalog(db,userId,{category,limit=25,offset=0,include_planned=true},env=null){
  // One connection read for the whole response: the capability entries and the
  // account block come from the same snapshot. If it cannot be read, WHOOP
  // capabilities are not advertised as available.
  const account=await accountStatus(db,userId,env);
  const connected=account.whoop_connected===true;
  const unreadable=account.whoop_connected==='unknown';
  const available={};
  for(const [id,sql] of Object.entries({
    samsung:'SELECT id FROM samsung_health_records WHERE user_id=?1 LIMIT 1',
    'health-connect':'SELECT id FROM health_connect_records WHERE user_id=?1 LIMIT 1',
    'medical-context':'SELECT id FROM medical_context WHERE user_id=?1 AND reviewed_at IS NOT NULL LIMIT 1'
  })){
    // Health Connect availability comes from the same status snapshot as
    // account.health_connect, so the two cannot disagree. The table is read
    // again only when that snapshot is unavailable.
    const hcCount=account.health_connect?.records_stored;
    if(id==='health-connect'){
      if(Number.isSafeInteger(hcCount)){available[id]=hcCount>0;continue;}
      // Fail soft, like the account block: unknown rather than an aborted response.
      try{available[id]=!!await db.prepare(sql).bind(userId).first();}catch{available[id]=null;}
      continue;
    }
    available[id]=!!await db.prepare(sql).bind(userId).first();
  }
  const localTools={'samsung':'get_samsung_health','health-connect':'get_health_connect','medical-context':'get_medical_context'};
  // Same rule as the summary path, the only path that can return the estimate.
  const stressOn=env?.STRESS_ESTIMATE_ENABLED==='true'&&env?.AI_SUMMARY_ENABLED==='true';
  const flareOn=env?.FLARE_JOURNAL_ENABLED==='true';
  const flareCapability={id:'private-flare-journal',name:'Opt-in flare journal and descriptive personal patterns',category:'optional',delivery:'mcp_tool',
    tools:['set_flare_consent','save_flare_context','save_flare_entry','get_flare_journal','delete_flare_entry','pause_flare_analysis','withdraw_flare_journal','analyze_flare_patterns'],status:'available',
    description:"User-reported condition context and journal, with separately authorized comparisons against this account's WHOOP history.",
    provides:'Private journal lifecycle and exploratory dated comparisons; no flare prediction or notifications.',
    data_requirements:['Explicit journal storage consent; separate analysis consent plus WHOOP connection and user labels for comparisons.'],
    limitations:['No automatic enrollment or diagnosis inference. Missing labels are not non-flare controls. Predictions remain disabled.'],example_prompts:['Explain flare-journal consent before I opt in.']};
  const capabilities=[...manifest.capabilities,...(stressOn?[STRESS_CAPABILITY]:[]),...(flareOn?[flareCapability]:[])].map(item=>{
    let value={...item};
    if(localTools[item.id]){
      const health=item.id==='health-connect';
      return {...value,category:'optional',delivery:'mcp_tool',
        name:health?'Health Connect records':value.name,
        description:health?'Reads Health Connect records stored for this account from a file import or phone ingest. Supplementary to WHOOP, with its own source label.':value.description,
        tools:[localTools[item.id]],status:available[item.id]===true?'available':'requires_connection_or_data',
        provides:health?'Reads stored Health Connect records. Phone ingest requires its own token and server flag.':'Reads existing authorized records; does not import or sync new data.',
        data_requirements:health?['A stored file import, or an issued phone ingest token while that server flag is on.']:value.data_requirements,
        limitations:['Records are source-labeled and account-scoped. Phone ingest stays off until a token is issued and the server flag is on.',
          'An issued ingest token is not evidence of data: check records_stored in account.health_connect.'],
        availability_reason:available[item.id]===null?'Stored records could not be checked right now; treat availability as unknown.':
          available[item.id]?'Authorized records exist.':'No authorized records are present for this account.'};
    }
    const needsWhoop=item.tools.some(t=>['get_profile','get_body_measurements','get_recovery','get_sleep','get_workouts','get_cycles'].includes(t));
    return {...value,status:needsWhoop&&!connected?'requires_connection_or_data':item.status,
      availability_reason:needsWhoop&&unreadable?'The WHOOP connection could not be confirmed right now; get_capabilities again shortly.':
        needsWhoop&&!connected?'Connect WHOOP first.':
        item.delivery==='host_assisted'?'Depends on the AI host and sufficient user-provided or connected data.':
        item.status==='planned'||item.status==='unsupported'?'Not provided by this service.':'Registered; record completeness is not guaranteed.'};
  }).filter(item=>(!category||item.category===category)&&(include_planned||!['planned','unsupported'].includes(item.status)));
  return {schema_version:manifest.schema_version,registry_version:'cloudflare-1.3',source:'bundled_cloudflare_catalog',
    source_hierarchy:SOURCE_HIERARCHY,
    server_features:featureStates(env),account,
    global_limitations:[...manifest.global_limitations.filter(s=>!s.startsWith('Android Health Connect')),
      'Local record tools read stored records for the signed-in account.',
      'Health Connect phone ingest stays off until an ingest token is issued and the server flag is on. File import is a separate consent.',
      ...(stressOn?["An experimental WHOOP Lens physiological stress estimate is enabled on this server. It is not WHOOP's Stress Monitor and not clinically validated; Stress Monitor zone data remains unsupported."]:[])],
    total:capabilities.length,next_offset:offset+limit<capabilities.length?offset+limit:null,
    capabilities:capabilities.slice(offset,offset+limit)};
}
