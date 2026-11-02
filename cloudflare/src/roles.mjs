// Owner/member boundary for MCP. The owner is exactly the server-configured
// WHOOP_LENS_DEVELOPER_USER_ID compared with the verified identity from the
// router. No tool argument, client claim, email or name can change it.
export const OWNER_ONLY_TOOLS=Object.freeze(new Set([
  'review_issue_reports','update_issue_report','get_reportable_links',
  'create_service_announcement','update_service_announcement','manage_service_announcements'
]));
export function isVerifiedOwner(env,userId){
  const owner=env?.WHOOP_LENS_DEVELOPER_USER_ID;
  return typeof owner==='string'&&owner.length>0&&typeof userId==='string'&&owner===userId;
}
export const ownerOnly=name=>OWNER_ONLY_TOOLS.has(name);
// Discovery filter applied last, after every feature module's own filtering.
export function memberSafeCatalog(tools,env,userId){
  return isVerifiedOwner(env,userId)?tools:tools.filter(tool=>!ownerOnly(tool.name));
}
