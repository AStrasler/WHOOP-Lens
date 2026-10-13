import {extraTools,extraArguments,readExtraTool} from './extra-tools.mjs';
import {revokeWhoopConnection} from './whoop-oauth.mjs';
import {importHealthConnectFile,withdrawHealthConnectImport,publicImportError} from './health-import.mjs';
import {issueIngestToken,revokeIngestTokens} from './health-connect-webhook.mjs';
import {hostInstructions,serverInfo} from './host-instructions.mjs';
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
    next_token:{type:"string",minLength:1,maxLength:512},
    auto_page:{type:"boolean",description:"Fetch up to four WHOOP pages (100 records maximum)"}
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
export const mcpTools=Object.freeze([...Object.keys(toolToResource).map(name=>({
  name,description:toolLabels[name],
  inputSchema:historyTools.has(name)?schemaHistory:schemaNoArgs,
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}
})),...extraTools]);
const toolsByName=new Map(mcpTools.map(x=>[x.name,x]));
const own=(x,p)=>Object.prototype.hasOwnProperty.call(x,p);
function isObject(x){return x!==null&&typeof x==="object"&&!Array.isArray(x);}
function fail(code,message,id){return {jsonrpc:"2.0",id,error:{code,message}};}
function ok(id,result){return {jsonrpc:"2.0",id,result};}
function toolError(id,message,modern) {
  const result={content:[{type:"text",text:message}],isError:true};
  if(modern)result.resultType="complete";
  return ok(id,result);
}
function checkArguments(name,args) {
  if(!isObject(args))return null;
  if(extraTools.some(t=>t.name===name))return extraArguments(name,args);
  const history=historyTools.has(name);
  if(Object.keys(args).some(k=>!(history&&["limit","next_token","auto_page"].includes(k))))return null;
  if(!history)return Object.keys(args).length===0?{}:null;
  const limit=args.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)return null;
  if(args.auto_page!=null&&typeof args.auto_page!=="boolean")return null;
  if(args.next_token!=null&&(typeof args.next_token!=="string"||
     args.next_token.length<1||args.next_token.length>512||
     !/^[A-Za-z0-9._~+/-]+$/.test(args.next_token)||
     args.next_token.includes("..")))return null;
  if(args.auto_page===true&&args.next_token!=null)return null;
  return {limit,next_token:args.next_token??null,auto_page:args.auto_page??false};
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
export async function handleMcpRpc(message,{db,userId,env,whoopRequest,whoopAuthorize},transport){
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
      serverInfo,instructions:hostInstructions});
  }
  if(message.method==="server/discover"){
    if(!modern)return fail(-32601,"Method not found",id);
    return ok(id,{resultType:"complete",supportedVersions:[PROTOCOL_CURRENT],capabilities:{tools:{}},ttlMs:0,cacheScope:"private",serverInfo,_meta:{"io.modelcontextprotocol/serverInfo":serverInfo},instructions:hostInstructions});
  }
  if(message.method==="ping")return ok(id,{});
  if(message.method==="tools/list"){
    return ok(id,modern?
      {resultType:"complete",tools:mcpTools,ttlMs:300000,cacheScope:"private"}:
      {tools:mcpTools});
  }
  if(message.method!=="tools/call")return fail(-32601,"Method not found",id);
  const name=params.name;
  if(typeof name!=="string"||!toolsByName.has(name))
    return fail(-32602,"Unknown tool",id);
  const args=checkArguments(name,params.arguments??{});
  if(args===null)return fail(-32602,"Invalid tool arguments",id);
  try {
    const resource=toolToResource[name];
    let data;
    if(name==='connect_whoop'){
      if(env.WHOOP_OAUTH_ENABLED!=='true'||typeof whoopAuthorize!=='function')throw Error('Connection disabled');
      const result=await whoopAuthorize(db,userId,env);
      const content={content:[{type:'text',text:result.authorization_url}]};
      if(modern){content.resultType='complete';content.structuredContent=result;}
      return ok(id,content);
    }else if(name==='disconnect_whoop'){
      if(env.WHOOP_OAUTH_ENABLED!=='true')throw Error('Connection disabled');
      data=await revokeWhoopConnection(db,userId);
    }else if(name==='import_health_connect_file'){
      if(env.WEB_HEALTH_IMPORT_ENABLED!=='true')throw Error('Connection disabled');
      data=await importHealthConnectFile(db,userId,args.file_json,args.consent);
    }else if(name==='withdraw_health_connect_import'){
      if(env.WEB_HEALTH_IMPORT_ENABLED!=='true'&&env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')
        throw Error('Connection disabled');
      data=await withdrawHealthConnectImport(db,userId,args.confirm);
    }else if(name==='issue_health_connect_ingest_token'){
      if(env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')throw Error('Connection disabled');
      data=await issueIngestToken(db,userId,args.consent);
    }else if(name==='revoke_health_connect_ingest_token'){
      if(env.HEALTH_CONNECT_WEBHOOK_ENABLED!=='true')throw Error('Connection disabled');
      data=await revokeIngestTokens(db,userId,args.confirm);
    }else if(extraTools.some(t=>t.name===name)){
      data=await readExtraTool(db,userId,name,args);
    }else if(!historyTools.has(name)||!args.auto_page){
      data=await whoopRequest(db,userId,resource,env,args);
    }else{
      const records=[];
      let cursor=null,pages=0;
      for(let i=0;i<4;i++){
        const batch=await whoopRequest(db,userId,resource,env,{limit:25,next_token:cursor});
        if(!isObject(batch)||!Array.isArray(batch.records))throw Error("Unexpected WHOOP page");
        if(batch.records.length>25)throw Error("WHOOP page oversized");
        records.push(...batch.records);
        pages++;
        const next=batch.next_token??null;
        if(next!=null&&(typeof next!=="string"||next.length>512||next===cursor))
          throw Error("Invalid WHOOP cursor");
        cursor=next;
        if(cursor===null)break;
      }
      data={records,next_token:cursor,complete:cursor===null,pages_fetched:pages};
    }
    const result={content:[{type:"text",text:JSON.stringify(data)}]};
    if(modern){result.resultType="complete";result.structuredContent=data;}
    return ok(id,result);
  }catch(error){
    // No details about secrets, token status, providers, account existence or SQL.
    // File-import validation messages are safe to show; everything else stays generic.
    const safe=publicImportError(error);
    return toolError(id,safe||"WHOOP data is unavailable for this connection.",modern);
  }
}
