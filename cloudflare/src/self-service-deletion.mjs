// Member self-service deletion (#138). Caller-scoped only: every statement binds the verified
// user ID, no argument can name another member or record, and each tool needs its exact
// confirmation constant. Medical context is intentionally not deletable here (owner policy:
// reviewed data stays with the privacy request page).
import {activeMembership} from './storage.mjs';

export const SAMSUNG_DELETE_CONFIRMATION='delete-my-samsung-health-records';
export const ISSUE_REPORTS_DELETE_CONFIRMATION='delete-my-issue-reports';

export class DeletionRejected extends Error{
  constructor(code){super(code);this.code=code;}
}
const destructive=Object.freeze({readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false});
const confirmSchema=value=>({type:'object',properties:{confirm:{type:'string',const:value}},required:['confirm'],additionalProperties:false});

export const deleteSamsungTool=Object.freeze({
  name:'delete_my_samsung_health_records',
  description:"Permanently delete every Samsung Health record WhoopLens stores for the signed-in member. Use ONLY when the member explicitly asks in this conversation to delete their Samsung Health records; never infer it and never as cleanup. Set confirm to the exact constant only after that request. Deletes this member's rows only; WHOOP data, Health Connect records and Samsung Health itself are not changed. Returns the number of records deleted.",
  inputSchema:confirmSchema(SAMSUNG_DELETE_CONFIRMATION),
  annotations:destructive
});
export const deleteIssueReportsTool=Object.freeze({
  name:'delete_my_issue_reports',
  description:"Permanently delete the issue reports the signed-in member submitted, so the server owner no longer sees them. Use ONLY when the member explicitly asks in this conversation to delete their own issue reports; never infer it. Set confirm to the exact constant only after that request. Reports submitted today (UTC) are kept until the next UTC day, because they count toward the daily report limit; the reply says how many were kept. Sanitized diagnostic codes (no text or health data) are separate and expire on their own after 30 days.",
  inputSchema:confirmSchema(ISSUE_REPORTS_DELETE_CONFIRMATION),
  annotations:destructive
});

// Samsung deletion is a base tool (listed with get_samsung_health in mcp.mjs).
// Issue-report deletion follows the issue-report feature flag, like report_issue.
export function deletionToolsFor(env){
  return env?.ISSUE_REPORTS_ENABLED==='true'?[deleteIssueReportsTool]:[];
}
export const isDeletionTool=name=>name===deleteSamsungTool.name||name===deleteIssueReportsTool.name;
export function deletionArguments(name,args){
  if(!args||typeof args!=='object'||Array.isArray(args))return null;
  const keys=Object.keys(args);
  const expected=name===deleteSamsungTool.name?SAMSUNG_DELETE_CONFIRMATION:name===deleteIssueReportsTool.name?ISSUE_REPORTS_DELETE_CONFIRMATION:null;
  if(!expected)return null;
  return keys.length===1&&keys[0]==='confirm'&&args.confirm===expected?{confirm:args.confirm}:null;
}

const utcDay=now=>new Date(now).toISOString().slice(0,10);

export async function runDeletionTool(name,args,{db,userId,now=Date.now()}){
  if(deletionArguments(name,args)===null)throw new DeletionRejected('confirmation_required');
  if(!await activeMembership(db,userId))throw new DeletionRejected('not_authorized');
  if(name===deleteSamsungTool.name){
    const run=await db.prepare('DELETE FROM samsung_health_records WHERE user_id=?1').bind(userId).run();
    if(!run?.success)throw new DeletionRejected('unavailable');
    return {deleted:run.meta?.changes??0,category:'samsung_health_records',changed_by:'member_request',
      note:'Deleted from WhoopLens for this account only. Samsung Health, WHOOP data and Health Connect records were not changed.'};
  }
  if(name===deleteIssueReportsTool.name){
    const today=utcDay(now);
    const run=await db.prepare('DELETE FROM issue_reports WHERE user_id=?1 AND day_key<>?2').bind(userId,today).run();
    if(!run?.success)throw new DeletionRejected('unavailable');
    const kept=await db.prepare('SELECT COUNT(*) AS n FROM issue_reports WHERE user_id=?1 AND day_key=?2').bind(userId,today).first();
    const remaining=Number(kept?.n??0);
    return {deleted:run.meta?.changes??0,kept_until_tomorrow:remaining,category:'issue_reports',changed_by:'member_request',
      note:remaining?`${remaining} report(s) submitted today (UTC) were kept because they count toward today's report limit. Ask again after 00:00 UTC to delete them.`:
        'All of this account\'s issue reports were deleted.'};
  }
  throw new DeletionRejected('invalid_request');
}
export function deletionToolError(error){
  const code=error instanceof DeletionRejected?error.code:'unavailable';
  if(code==='not_authorized')return 'Deletion is only available to active members. Nothing was deleted.';
  if(code==='confirmation_required')return 'Deletion needs the exact confirmation after an explicit member request. Nothing was deleted.';
  return 'Deletion could not be completed right now. Nothing was confirmed as deleted; retry shortly, or use https://www.whooplens.tech/privacy/.';
}
