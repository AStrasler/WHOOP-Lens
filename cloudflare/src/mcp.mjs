import {flareTools,flareEnabled,flareArguments,runFlareTool} from './flare-journal.mjs';
import {notionTools,isNotionTool,notionArguments,runNotionTool,publicNotionError} from './notion.mjs';
import {notionEnabled} from './notion-client.mjs';
import {errorReportToolsFor,isErrorReportTool,errorReportArguments,runErrorReportTool} from './error-reports.mjs';
import {activeMembership,connectionStatus} from './storage.mjs';
import {extraTools,extraArguments,readExtraTool} from './extra-tools.mjs';
import {aiSummaryEnabled,attachSummary,summaryTools} from './ai-summary.mjs';
import {buildWeeklyDigest,parseWeekEnding,weeklyDigestEnabled} from './ai-digest.mjs';
import {readOwnUsage,utcDay} from './ai-quota.mjs';
import {revokeWhoopConnection} from './whoop-oauth.mjs';
import {FeatureDisabled} from './member-guidance.mjs';
import {importHealthConnectFile,withdrawHealthConnectImport,publicImportError} from './health-import.mjs';
import {issueIngestToken,revokeIngestTokens} from './health-connect-webhook.mjs';
import {hostInstructionsFor,serverInfo} from './host-instructions.mjs';
import {CursorError,cursorShapeOk,readHistoryPages,CURSOR_MAX_LENGTH} from './history-pagination.mjs';
import {SeatsFull} from './seat-limit.mjs';
import {memberLimitMessage} from './member-rate-limit.mjs';
import {capture,classifyToolError,newRequestId,validRequestId,toolSubsystem} from './diagnostics.mjs';
import {issueToolsFor,issueArguments,reportIssue,reviewIssueReports,updateIssueReport,ReportNotSubmitted} from './issue-reports.mjs';
// Private WHOOP Lens MCP on Cloudflare. Supabase whoop-mcp stays up in parallel.
// The HTTP router MUST validate the bearer and ACTIVE membership before calling
// this module. Do not copy WHOOP refresh tokens from Supabase.
const PROTOCOL_CURRENT="2026-07-28";
const PROTOCOL_LEGACY="2025-11-25";
const PROTOCOL_CHATGPT_2025_06="2025-06-18";
const PROTOCOL_CHATGPT_2025_03="2025-03-26";
const protocolVersions=new Set([
  PROTOCOL_CURRENT,PROTOCOL_LEGACY,PROTOCOL_CHATGPT_2025_06,PROTOCOL_CHATGPT_2025_03
]);
const initializeVersions=new Set([PROTOCOL_LEGACY,PROTOCOL_CHATGPT_2025_06,PROTOCOL_CHATGPT_2025_03]);
const toolToResource=Object.freeze({
  get_profile:"profile",
  get_body_measurements:"measurements",
  get_recovery:"recovery",
  get_sleep:"sleep",
  get_workouts:"workouts",
  get_cycles:"cycles"
});
const historyTools=new Set(["get_recovery","get_sleep","get_workouts","get_cycles"]);
const schemaNoArgs=Object.freeze({type:"object",properties:{},additionalProperties:false});
const schemaHistory=Object.freeze({
  type:"object",
  properties:{
    limit:{type:"integer",minimum:1,maximum:25},
    next_token:{type:"string",minLength:1,maxLength:CURSOR_MAX_LENGTH,
      description:"Opaque cursor from the previous call's next_token. Pass it back unchanged to continue; it works with or without auto_page and expires after one hour."},
    auto_page:{type:"boolean",description:"Fetch up to four WHOOP pages (100 records maximum) per call. If next_token is returned, call again with it to continue."}
  },
  additionalProperties:false
});
const toolLabels=Object.freeze({
  get_profile:"Read the signed-in user's WHOOP profile.",
  get_body_measurements:"Read the signed-in user's WHOOP body measurements.",
  get_recovery:"Read the signed-in user's WHOOP recovery history.",
  get_sleep:"Read the signed-in user's WHOOP sleep history.",
  get_workouts:"Read the signed-in user's WHOOP workout history.",
  get_cycles:"Read the signed-in user's WHOOP cycle history."
});
const WHOOP_NOTE=" Authoritative WHOOP measurements (source \"whoop\"); if they are missing or stale, say so and never fill the gap from another source."+
  " Every record is returned exactly as WHOOP provides it and is an authoritative WHOOP record whatever its origin; WHOOP does not say which records the person entered, so keep entry_origin unknown unless the person says so.";
// The WHOOP v2 API has no field that marks a record as user-entered or
// sensor-generated, so origin is reported as unknown rather than guessed.
const ENTRY_ORIGIN_NOTE="The WHOOP API does not mark records as user-entered or sensor-generated. Records are passed through unmodified; nap is WHOOP's own field.";
// WHOOP read results are labeled with their source. History pages also get
// whoop_measurements: how many records came back, the newest record time, and
// (on a first page of recovery, sleep or cycles) whether it is over 36 hours old.
const STALE_MS=36*3600*1000;
export function attributeWhoop(data,name,firstPage,now=Date.now()){
  if(!data||typeof data!=='object'||Array.isArray(data)||'source' in data)return data;
  const out={source:'whoop',source_authority:'authoritative',...data};
  if(!Array.isArray(data.records))return out;
  // First timestamp that parses, so an empty or malformed end does not hide a valid start or created_at.
  const times=data.records.map(r=>[r?.end,r?.start,r?.created_at].map(t=>typeof t==='string'?Date.parse(t):NaN).find(Number.isFinite)).filter(Number.isFinite);
  const latest=times.length?Math.max(...times):null;
  const empty=data.records.length===0;
  // An empty page proves "no records" only when it is the first page and the sequence is complete.
  const records_status=!empty?'records_returned':firstPage&&data.complete===true?'none_in_range':
    data.complete===true?'continuation_page_empty':'empty_page_more_may_exist';
  const m={records_returned:data.records.length,missing:records_status==='none_in_range',records_status,
    latest_record_at:latest===null?null:new Date(latest).toISOString(),
    entry_origin:'unknown',entry_origin_note:ENTRY_ORIGIN_NOTE};
  if(name==='get_sleep')m.naps_returned=data.records.filter(r=>r?.nap===true).length;
  if(firstPage&&name!=='get_workouts'){
    if(records_status==='empty_page_more_may_exist'){m.stale=null;m.stale_reason='page_incomplete';}
    else if(!empty&&latest===null){m.stale=null;m.stale_reason='no_valid_timestamp';}
    else m.stale=latest===null||now-latest>STALE_MS;
  }
  out.whoop_measurements=m;
  return out;
}
export const mcpTools=Object.freeze([...Object.keys(toolToResource).map(name=>({
  name,description:toolLabels[name]+WHOOP_NOTE,
  inputSchema:historyTools.has(name)?schemaHistory:schemaNoArgs,
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
})),...extraTools]);
const toolsByName=new Map(mcpTools.map(x=>[x.name,x]));
const own=(x,p)=>Object.prototype.hasOwnProperty.call(x,p);
function isObject(x){return x!==null&&typeof x==="object"&&!Array.isArray(x);}
const aiUsageTool=Object.freeze({
  name:"get_ai_usage",
  description:"Read this account's AI summary quota for the current UTC day.",
  inputSchema:{type:"object",properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
});
const weeklyDigestTool=Object.freeze({
  name:"get_weekly_digest",
  description:"Pull this account's weekly measurement digest. Call it with no arguments. Optional week_ending (YYYY-MM-DD) selects the last day of the window; the default is the most recent complete Monday-Sunday week. The result has text, chart_data, insights, and status (model or template). A repeat for a completed window returns the cached digest and does not spend more quota. Windows ending today or later are refreshed and not cached. When summaries are on, a template fallback is not cached. The digest is not sent.",
  inputSchema:{type:"object",properties:{
    week_ending:{type:"string",description:"Last day of the seven-day window, YYYY-MM-DD. Defaults to the most recent complete Monday-Sunday week."}
  },additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
});
function listedTools(env,userId){
  const issueTools=[...issueToolsFor(env,userId),...errorReportToolsFor(env,userId)];
  const tools=issueTools.length?[...baseListedTools(env),...issueTools]:baseListedTools(env);
  return notionEnabled(env)?[...tools,...notionTools]:tools;
}
function baseListedTools(env){
  const summaryOn=aiSummaryEnabled(env);
  const digestOn=weeklyDigestEnabled(env);
  if(!summaryOn&&!digestOn&&!flareEnabled(env))return mcpTools;
  let tools=summaryOn?mcpTools.map(tool=>summaryTools.has(tool.name)?{...tool,inputSchema:{
    ...tool.inputSchema,
    properties:{...tool.inputSchema.properties,summary:{type:"boolean",description:"Add a summary of these results. Ignored unless true."}}
  }}:tool):mcpTools.slice();
  if(summaryOn)tools=[...tools,aiUsageTool];
  if(digestOn)tools=[...tools,weeklyDigestTool];
  if(flareEnabled(env))tools=[...tools,...flareTools];
  return tools;
}
function optionalTool(name,env,userId){
  if(isErrorReportTool(name))return errorReportToolsFor(env,userId).some(t=>t.name===name);
  if(isNotionTool(name))return notionEnabled(env);
  if(issueToolsFor(env,userId).some(t=>t.name===name))return true;
  if(flareTools.some(t=>t.name===name))return flareEnabled(env);
  if(name==="get_ai_usage")return aiSummaryEnabled(env);
  if(name==="get_weekly_digest")return weeklyDigestEnabled(env);
  return false;
}
function usageAdmin(env,userId){
  const owner=env?.WHOOP_LENS_DEVELOPER_USER_ID;
  return typeof owner==="string"&&owner.length>0&&owner===userId;
}
function queryArgs(args){
  if(!isObject(args)||args.summary!==true)return args;
  const copy={...args};
  delete copy.summary;
  return copy;
}
function fail(code,message,id){return {jsonrpc:"2.0",id,error:{code,message}};}
function ok(id,result){return {jsonrpc:"2.0",id,result};}
function toolError(id,message,modern) {
  const result={content:[{type:"text",text:message}],isError:true};
  if(modern)result.resultType="complete";
  return ok(id,result);
}
function checkArguments(name,args,env,userId) {
  if(!isObject(args))return null;
  if(isErrorReportTool(name))return errorReportToolsFor(env,userId).some(t=>t.name===name)?errorReportArguments(name,args):null;
  if(isNotionTool(name))return notionEnabled(env)?notionArguments(name,args):null;
  if(issueToolsFor(env,userId).some(t=>t.name===name))return issueArguments(name,args);
  if(flareTools.some(t=>t.name===name))return flareEnabled(env)?flareArguments(name,args):null;
  if(name==="get_ai_usage"){
    if(!aiSummaryEnabled(env))return null;
    return Object.keys(args).length===0?{}:null;
  }
  if(name==="get_weekly_digest"){
    if(!weeklyDigestEnabled(env))return null;
    if(Object.keys(args).some(key=>key!=="week_ending"))return null;
    if(!own(args,"week_ending"))return {};
    const weekEnding=parseWeekEnding(args.week_ending);
    return weekEnding?{week_ending:weekEnding}:null;
  }
  const summaryOn=aiSummaryEnabled(env)&&summaryTools.has(name);
  if(extraTools.some(t=>t.name===name)){
    if(!summaryOn||!own(args,"summary"))return extraArguments(name,args);
    if(typeof args.summary!=="boolean")return null;
    const rest={...args};
    delete rest.summary;
    const parsed=extraArguments(name,rest);
    if(!parsed)return null;
    return args.summary?{...parsed,summary:true}:parsed;
  }
  const history=historyTools.has(name);
  const allowed=history?["limit","next_token","auto_page"]:[];
  if(summaryOn)allowed.push("summary");
  if(Object.keys(args).some(k=>!allowed.includes(k)))return null;
  if(!history){
    if(!summaryOn||!own(args,"summary"))return Object.keys(args).length===0?{}:null;
    if(args.summary==null)return Object.keys(args).length===1?{}:null;
    if(typeof args.summary!=="boolean")return null;
    return args.summary?{summary:true}:{};
  }
  // Clients may send optional fields as null (or an empty cursor); treat those as absent.
  if(summaryOn&&own(args,"summary")&&args.summary!=null&&typeof args.summary!=="boolean")return null;
  const limit=args.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)return null;
  if(args.auto_page!=null&&typeof args.auto_page!=="boolean")return null;
  const cursor=args.next_token===""?null:(args.next_token??null);
  // Shape only here; the cursor is authenticated against the member later.
  if(cursor!=null&&!cursorShapeOk(cursor))return null;
  // auto_page with next_token continues an automatic sequence from the cursor.
  const out={limit,next_token:cursor,auto_page:args.auto_page??false};
  if(summaryOn&&args.summary===true)out.summary=true;
  return out;
}
export function validateMcpTransport(request,message){
  if(!isObject(message))return {status:400,error:"Invalid MCP request"};
  const version=request.headers.get("mcp-protocol-version");
  if(version!=null&&!protocolVersions.has(version))
    return {status:400,error:"Unsupported MCP protocol version"};
  const modern=version===PROTOCOL_CURRENT;
  if(modern){
    const method=request.headers.get("mcp-method");
    if(method!==message?.method)return {status:400,error:"MCP method header mismatch"};
    const name=request.headers.get("mcp-name");
    if(message.method==="tools/call"){
      if(typeof message.params?.name!=="string"||name!==message.params.name)
        return {status:400,error:"MCP tool header mismatch"};
    }else if(name!=null)return {status:400,error:"Unexpected MCP tool header"};
  }
  return {version:version||PROTOCOL_LEGACY,modern};
}
// Fixed labels for member messages (WHOOP resource keys in whoop-api.mjs).
const WHOOP_DATA_LABELS=Object.freeze({profile:"your WHOOP profile",measurements:"your body measurements",
  recovery:"recovery data",sleep:"sleep data",workouts:"workout data",cycles:"cycle data"});
export async function handleMcpRpc(message,{db,userId,env,whoopRequest,whoopAuthorize,requestId:givenRequestId},transport){
  const requestId=validRequestId(givenRequestId)?givenRequestId:newRequestId();
  const modern=transport.modern;
  if(!isObject(message)||message.jsonrpc!=="2.0")
    return fail(-32600,"Invalid JSON-RPC request",null);
  const id=message.id;
  if(!own(message,"id")) {
    // Accept notification but do not execute it; HTTP layer sends 202.
    return null;
  }
  if(!(typeof id==="string"||Number.isSafeInteger(id)||id===null) ||
     (typeof id==="string"&&id.length>120))
    return fail(-32600,"Invalid JSON-RPC request",null);
  if(typeof message.method!=="string")return fail(-32600,"Invalid JSON-RPC request",id);
  if(!isObject(message.params)&&message.params!==undefined)
    return fail(-32602,"Invalid parameters",id);
  const params=message.params||{};
  if(message.method==="initialize"){
    if(modern)return fail(-32601,"Method not available for stateless MCP",id);
    if(!isObject(params.clientInfo)||!isObject(params.capabilities)||
       typeof params.protocolVersion!=="string"||
       !initializeVersions.has(params.protocolVersion))
      return fail(-32602,"Unsupported or invalid initialize request",id);
    return ok(id,{protocolVersion:params.protocolVersion,capabilities:{tools:{}},
      serverInfo,instructions:hostInstructionsFor(env)});
  }
  if(message.method==="server/discover"){
    if(!modern)return fail(-32601,"Method not found",id);
    return ok(id,{resultType:"complete",supportedVersions:[PROTOCOL_CURRENT],capabilities:{tools:{}},ttlMs:0,cacheScope:"private",serverInfo,_meta:{"io.modelcontextprotocol/serverInfo":serverInfo},instructions:hostInstructionsFor(env)});
  }
  if(message.method==="ping")return ok(id,{});
  if(message.method==="tools/list"){
    const tools=listedTools(env,userId);
    return ok(id,modern?
      {resultType:"complete",tools,ttlMs:300000,cacheScope:"private"}:
      {tools});
  }
  if(message.method!=="tools/call")return fail(-32601,"Method not found",id);
  const name=params.name;
  if(typeof name!=="string"||(!toolsByName.has(name)&&!optionalTool(name,env,userId)))
    return fail(-32602,"Unknown tool",id);
  const args=checkArguments(name,params.arguments??{},env,userId);
  if(args===null){
    await capture(env,db,{category:"mcp_validation",subsystem:toolSubsystem(name),code:"invalid_arguments",
      outcome:"fail",retryable:false,requestId,userId});
    return fail(-32602,"Invalid tool arguments",id);
  }
  try {
    const resource=toolToResource[name];
    let data;
    if(isErrorReportTool(name)){
      data=await runErrorReportTool(name,args,{db,userId,env,requestId});
    }else if(isNotionTool(name)){
      data=await runNotionTool(name,args,{db,userId,env});
    }else if(flareTools.some(t=>t.name===name)){
      data=await runFlareTool(name,args,{db,userId,env,whoopRequest});
    }else if(name==='connect_whoop'){
      if(env.WHOOP_OAUTH_ENABLED!=='true'||typeof whoopAuthorize!=='function')throw new FeatureDisabled('whoop_connection');
      const result=await whoopAuthorize(db,userId,env);
      const content={content:[{type:'text',text:result.authorization_url}]};
      if(modern){content.resultType='complete';content.structuredContent=result;}
      return ok(id,content);
    }else if(name==='disconnect_whoop'){
      if(env.WHOOP_OAUTH_ENABLED!=='true')throw new FeatureDisabled('whoop_connection');
      data=await revokeWhoopConnection(db,userId);
    }else if(name==='import_health_connect_file'){
      if(env.WEB_HEALTH_IMPORT_ENABLED!=='true')throw new FeatureDisabled('health_connect_file_import');
      data=await importHealthConnectFile(db,userId,args.file_json,args.consent);
    }else if(name==='withdraw_health_connect_import'){
      if(env.WEB_HEALTH_IMPORT_ENABLED!=='true'&&env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')
        throw new FeatureDisabled('health_connect_withdraw');
      data=await withdrawHealthConnectImport(db,userId,args.confirm);
    }else if(name==='issue_health_connect_ingest_token'){
      if(env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')throw new FeatureDisabled('health_connect_phone_ingest');
      data=await issueIngestToken(db,userId,args.consent);
    }else if(name==='revoke_health_connect_ingest_token'){
      if(env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')throw new FeatureDisabled('health_connect_phone_ingest');
      data=await revokeIngestTokens(db,userId,args.confirm);
    }else if(name==="get_ai_usage"){
      const usage=await readOwnUsage(db,{
        userId,day:utcDay(),includeGlobal:usageAdmin(env,userId)
      });
      if(!usage.ok)throw Error("quota");
      data={day:usage.day,used:usage.used,cap:usage.cap,remaining:usage.remaining};
      if(usage.global)data.global=usage.global;
    }else if(name==="get_weekly_digest"){
      if(!(await connectionStatus(db,userId)).connected)throw Error("digest");
      const digest=await buildWeeklyDigest({db,userId,env,whoopRequest,weekEnding:args.week_ending});
      // Report the real cause (member budget, WHOOP 429/401/5xx) for a member who
      // is still connected and active, never "not connected or no data".
      if(!digest.ok&&digest.error&&(await connectionStatus(db,userId)).connected&&await activeMembership(db,userId))throw digest.error;
      if(!digest.ok||!(await connectionStatus(db,userId)).connected||!await activeMembership(db,userId))throw Error("digest");
      data={kind:digest.kind,week_ending:digest.week_ending,period:digest.period,
        text:digest.text,chart_data:digest.chart_data,insights:digest.insights,
        status:digest.status,cached:digest.cached===true};
    }else if(name==="report_issue"){
      data=await reportIssue(db,userId,args,{requestId,env});
    }else if(name==="review_issue_reports"){
      data=await reviewIssueReports(db,userId,args,{env});
    }else if(name==="update_issue_report"){
      data=await updateIssueReport(db,userId,args,{env});
    }else if(extraTools.some(t=>t.name===name)){
      data=await readExtraTool(db,userId,name,queryArgs(args),env);
      if(name==='get_capabilities'&&(args.offset??0)===0){
        // Describe the same caller-filtered inventory used by discovery.
        // Never advertise owner-only controls to ordinary members.
        data.tool_permissions=listedTools(env,userId).map(tool=>({
          tool:tool.name,allowed_use:tool.description,
          owner_only:['get_reportable_links','review_issue_reports','update_issue_report'].includes(tool.name),
          read_only_hint:tool.annotations?.readOnlyHint===true,
          destructive_hint:tool.annotations?.destructiveHint===true
        }));
        data.permissions_scope='All tools currently registered for this authenticated caller. Server flags, account ownership, consent, confirmation, quota and record availability still apply. Not limited by capability-category pagination.';
      }
    }else if(!historyTools.has(name)){
      data=attributeWhoop(await whoopRequest(db,userId,resource,env,queryArgs(args)),name,false);
    }else{
      // userId is the verified member from the router, never a tool argument.
      data=attributeWhoop(await readHistoryPages({db,userId,resource,env,whoopRequest,
        limit:args.limit,cursor:args.next_token,auto:args.auto_page===true}),name,args.next_token==null);
    }
    if(args.summary===true&&aiSummaryEnabled(env)){
      try{
        data=await attachSummary(data,{db,userId,env,tool:name,whoopRequest});
        const reason=data?.summary?.status==="template"?data.summary.fallback_reason:null;
        if(typeof reason==="string"&&/^[a-z_]{1,30}$/.test(reason))
          await capture(env,db,{category:"ai_summary",subsystem:"ai_summary",code:"summary_fallback_"+reason,
            outcome:"partial",retryable:true,requestId,userId});
      }catch{
        /* Authorized records stay available when a summary fails. */
        await capture(env,db,{category:"ai_summary",subsystem:"ai_summary",code:"summary_failed",
          outcome:"partial",retryable:true,requestId,userId});
      }
    }
    const result={content:[{type:"text",text:JSON.stringify(data)}]};
    if(modern){result.resultType="complete";result.structuredContent=data;}
    return ok(id,result);
  }catch(error){
    const kind=classifyToolError(error,name);
    if(!(error instanceof ReportNotSubmitted))
      await capture(env,db,{...kind,outcome:"fail",requestId,userId});
    else await capture(env,db,{category:"mcp_tool",subsystem:"issue_reports",code:"report_not_submitted_"+error.reason,
      outcome:"fail",retryable:error.reason!=="too_short",requestId,userId});
    if(error instanceof ReportNotSubmitted)return toolError(id,error.message,modern);
    if(isNotionTool(name))return toolError(id,publicNotionError(error)+(Number.isSafeInteger(error.retryAfter)?` Retry after ${error.retryAfter} seconds.`:''),modern);
    // No details about secrets, token status, providers, account existence or SQL.
    // File-import validation messages are safe to show; everything else stays generic.
    if(error instanceof SeatsFull)return toolError(id,error.message,modern);
    if(error instanceof FeatureDisabled)return toolError(id,error.message,modern);
    if(error instanceof CursorError)return toolError(id,error.reason==="expired"?
      "This next_token has expired. Request the first page again without next_token.":
      "This next_token is not valid for this account and history category. Request the first page again without next_token.",modern);
    // WHOOP throttles the whole app (100 requests/minute by default). Say so,
    // instead of implying the member's connection is broken.
    // This account's own share of the WHOOP limit (member-rate-limit.mjs).
    if(error?.status===429&&error?.memberLimit===true&&!flareTools.some(t=>t.name===name))
      return toolError(id,memberLimitMessage(error),modern);
    if(error?.status===429&&!flareTools.some(t=>t.name===name)){
      const wait=Number.isSafeInteger(error.retryAfter)?` Wait about ${Math.max(1,error.retryAfter)} seconds,`:" Wait a minute,";
      return toolError(id,error?.cursorOutlived===true?
        `WHOOP is rate limiting requests right now.${wait} then request the first page again without next_token; the next_token you sent will have expired by then.`:
        `WHOOP is rate limiting requests right now.${wait} then retry the same call. Any next_token you hold stays valid for up to one hour.`,modern);
    }
    if(flareTools.some(t=>t.name===name))return toolError(id,'Flare journal request could not be completed. Verify consent, active membership, the current entry revision, and WHOOP connection for analysis. No medical data or internal error details are included.',modern);
    const safe=publicImportError(error);
    if(safe)return toolError(id,safe,modern);
    // Distinct, safe messages: no tokens, scopes, provider bodies or SQL.
    // Never suggests substituting Health Connect or Samsung Health data.
    if(error?.message==="WHOOP API request failed"){
      const what=Object.hasOwn(WHOOP_DATA_LABELS,String(error.resource))?WHOOP_DATA_LABELS[error.resource]:"this WHOOP data";
      if(error.status===401)return toolError(id,`WHOOP rejected this connection's authorization when reading ${what}. Retry once; if it keeps failing, reconnect WHOOP in WHOOP Lens. No WHOOP data was returned.`,modern);
      if(error.status===403)return toolError(id,`WHOOP denied access to ${what} for this connection. Reconnect WHOOP and approve every requested permission, then retry. No WHOOP data was returned.`,modern);
      if(error.status===404)return toolError(id,`WHOOP did not find ${what} for this request. No WHOOP data was returned.`,modern);
      if(error.network==="timeout")return toolError(id,`WHOOP did not respond in time when reading ${what}. Retry shortly. No WHOOP data was returned and nothing was changed.`,modern);
      if(error.status>=500||error.network)return toolError(id,`WHOOP is temporarily unavailable (reading ${what}). Retry shortly. No WHOOP data was returned and nothing was changed.`,modern);
    }
    if(/^WHOOP refresh|^Invalid WHOOP refresh/.test(error?.message||""))
      return toolError(id,"WHOOP Lens could not renew this connection's WHOOP authorization. Retry shortly; if it keeps failing, reconnect WHOOP. No WHOOP data was returned.",modern);
    return toolError(id,"WHOOP data is unavailable for this connection.",modern);
  }
}
