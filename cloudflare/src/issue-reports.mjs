// Member issue reports: a private D1 queue the server owner reviews. A member
// report is bound to the authenticated member (never a client-supplied id),
// needs an explicit approval round trip, is rate limited, and returns a
// reference only after the stored row is read back. Owner tools review and set
// a status; nothing here runs commands, changes infrastructure, rotates
// credentials, or changes permissions.
import {ACTIVE_MEMBER_SQL,activeMembership} from './storage.mjs';
import {KINDS,validRequestId,retentionStatements,REPORT_RETENTION_DAYS} from './diagnostics.mjs';
export {REPORT_RETENTION_DAYS};

export const APPROVAL_TTL_MS=10*60*1000;
const APPROVAL_RE=/^ira_[A-Za-z0-9_-]{43}$/;
const MAX_OPEN_APPROVALS=10;
export const STATUSES=Object.freeze(['new','acknowledged','resolved','recurring']);
// Per UTC day; duplicates count as submissions.
export const LIMITS=Object.freeze({perMemberPerDay:5,perMemberIntervalMs:60_000,serverPerDay:100});
const MAX_INPUT=1000,MAX_STORED=500,MIN_WORDS=2;

export function issueReportsEnabled(env){return env?.ISSUE_REPORTS_ENABLED==='true';}
export function isOwner(env,userId){
  const owner=env?.WHOOP_LENS_DEVELOPER_USER_ID;
  return typeof owner==='string'&&owner.length>0&&owner===userId;
}
// A report that was not stored. The message is always safe to show and always
// says no reference exists.
export class ReportNotSubmitted extends Error{
  constructor(reason){
    const text={rate_limited:'Too many reports were sent recently. Wait a while and try again.',
      unavailable:'Issue reporting is not available right now.',
      too_short:'Describe the problem in a few plain words first.',
      not_found:'No report with that reference was found.',
      approval_invalid:'This report needs a fresh preview, and the member must approve that exact text.'}[reason]??'The report could not be saved.';
    super(`${text} The report was not submitted and no reference was created.`);
    this.name='ReportNotSubmitted';this.reason=reason;
  }
}
// Removes what must never be stored: addresses, links, tokens, ids, and every
// number (health values, dates, phone numbers). Returns the clean text and the
// kinds of content removed.
export function sanitizeDescription(input){
  if(typeof input!=='string')return null;
  let text=input.slice(0,MAX_INPUT).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g,' ');
  const removed=new Set();
  const rules=[
    ['email',/[^\s@]+@[^\s@]+\.[^\s@]+/g,'[email]'],
    ['link',/\b(?:https?:\/\/|www\.)\S+/gi,'[link]'],
    ['credential',/\b(?:bearer|basic)\s+\S+/gi,'[credential]'],
    ['credential',/\b(?:hct|sk|pk|ghp|gho|xox[a-z]?)[_-][A-Za-z0-9_-]{6,}/gi,'[credential]'],
    ['credential',/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)*/g,'[credential]'],
    ['id',/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'[id]'],
    ['credential',/\b[A-Za-z0-9_+/=-]{24,}\b/g,'[credential]'],
    // A labeled value ("password: x", "api key = y", "my pin is z") is removed
    // whatever its shape. "is/was" only counts for secret-only labels, so
    // ordinary sentences such as "the token was issued" survive.
    ['credential',/\b(?:pass(?:word|code|phrase)?|pwd|pin|otp|token|secret|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|auth(?:orization)?|cookie|session(?:[\s_-]?id)?|credentials?|code)\s*[:=]\s*\S+/giu,'[credential]'],
    ['credential',/\b(?:pass(?:word|code|phrase)?|pwd|pin|otp|secret)\s+(?:is|was)\s+\S+/giu,'[credential]'],
    ['credential',/\S+\.\S+\.\S+/gu,'[credential]'],
    // Every number in any script (health values, dates, phone numbers).
    ['number',/\p{N}[\p{N}.,:/%-]*/gu,'[number]']
  ];
  for(const [kind,re,mark] of rules)text=text.replace(re,()=>{removed.add(kind);return mark;});
  text=text.replace(/[<>`{}\\]/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_STORED).trim();
  const words=text.replace(/\[(?:email|link|credential|id|number)\]/g,' ').match(/\p{L}{2,}/gu)??[];
  return {text,removed:[...removed].sort(),words:words.length};
}
async function sha256Hex(text){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newReference(){
  const bytes=crypto.getRandomValues(new Uint8Array(8));
  return 'WL-'+[...bytes].map(b=>ALPHABET[b%32]).join('');
}
function severityFor(kind,evidence){
  if(kind==='backend_failure'||evidence.some(e=>e.category==='infrastructure'||e.category==='auth'))return 'high';
  if(kind==='missing_consent'||kind==='incomplete_setup')return 'low';
  return 'medium';
}
const EVIDENCE_SQL='SELECT category,subsystem,code,outcome,retryable,count,last_at,request_id FROM diagnostic_events '+
  'WHERE user_key=?1 AND last_at>?2 ORDER BY last_at DESC LIMIT 10';
async function memberEvidence(db,userId,since){
  try{
    const rows=(await db.prepare(EVIDENCE_SQL).bind(userId,since).all())?.results??[];
    return rows.map(r=>({category:r.category,subsystem:r.subsystem,code:r.code,outcome:r.outcome,
      retryable:r.retryable===1,count:r.count,last_at:r.last_at,request_id:r.request_id}));
  }catch{return [];}
}
const MEMBER_EXISTS=`EXISTS (${ACTIVE_MEMBER_SQL})`;
// Limits count submissions (duplicates included) for the current UTC day, and
// the per-minute check uses the member's own last submission time.
const INSERT='INSERT INTO issue_reports(reference,user_id,category,severity,status,description,dedupe_key,request_id,'+
  'evidence_json,subsystems,occurrences,day_key,day_submissions,last_submitted_at,created_at,updated_at) '+
  "SELECT ?2,?1,?3,?4,'new',?5,?6,?7,?8,?9,1,?11,1,?10,?10,?10 WHERE "+MEMBER_EXISTS+
  ' AND (SELECT COALESCE(SUM(day_submissions),0) FROM issue_reports WHERE user_id=?1 AND day_key=?11)<?13'+
  ' AND NOT EXISTS (SELECT 1 FROM issue_reports WHERE user_id=?1 AND last_submitted_at>?12)'+
  ' AND (SELECT COALESCE(SUM(day_submissions),0) FROM issue_reports WHERE day_key=?11)<?14'+
  ' AND EXISTS (SELECT 1 FROM issue_report_approvals WHERE token_hash=?15 AND user_id=?1 AND dedupe_key=?6 AND expires_at>?16) '+
  'ON CONFLICT(user_id,dedupe_key) DO UPDATE SET occurrences=occurrences+1,'+
  'day_submissions=CASE WHEN day_key=excluded.day_key THEN day_submissions+1 ELSE 1 END,'+
  'day_key=excluded.day_key,last_submitted_at=excluded.last_submitted_at,'+
  "status=CASE WHEN status='resolved' THEN 'recurring' ELSE status END,"+
  'updated_at=excluded.updated_at,request_id=excluded.request_id,evidence_json=excluded.evidence_json,'+
  'subsystems=excluded.subsystems,severity=excluded.severity';
const CONFIRM_SQL='SELECT reference,occurrences,status,created_at FROM issue_reports '+
  'WHERE user_id=?1 AND dedupe_key=?2 AND request_id=?3 AND last_submitted_at=?4 LIMIT 1';
const PREVIEW='INSERT INTO issue_report_approvals(token_hash,user_id,dedupe_key,expires_at) SELECT ?2,?1,?3,?4 WHERE '+
  `EXISTS (${ACTIVE_MEMBER_SQL})`+' AND (SELECT COUNT(*) FROM issue_report_approvals WHERE user_id=?1 AND expires_at>?5)<?6';
const APPROVAL_OK='SELECT 1 AS ok FROM issue_report_approvals WHERE token_hash=?1 AND user_id=?2 AND dedupe_key=?3 AND expires_at>?4';
const CONSUME='DELETE FROM issue_report_approvals WHERE token_hash=?1 AND user_id=?2 AND EXISTS '+
  '(SELECT 1 FROM issue_reports WHERE user_id=?2 AND dedupe_key=?3 AND request_id=?4 AND last_submitted_at=?5)';
function approvalToken(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return 'ira_'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

export async function reportIssue(db,userId,args,{requestId,env,now=Date.now()}={}){
  if(!issueReportsEnabled(env))throw new ReportNotSubmitted('unavailable');
  if(!validRequestId(requestId))throw new ReportNotSubmitted('unavailable');
  const clean=sanitizeDescription(args.description);
  if(!clean||clean.words<MIN_WORDS)throw new ReportNotSubmitted('too_short');
  const kind=args.category;
  const since=new Date(now-86400000).toISOString();
  const key=await sha256Hex(userId+'\n'+kind+'\n'+clean.text.toLowerCase());
  if(args.approval_token===undefined){
    // Preview: store only a digest of a random approval token bound to this
    // member and this exact cleaned text. No report exists yet.
    const token=approvalToken();
    let run;
    try{
      const results=await db.batch([
        db.prepare(PREVIEW).bind(userId,await sha256Hex(token),key,now+APPROVAL_TTL_MS,now,MAX_OPEN_APPROVALS),
        ...retentionStatements(db,now)
      ]);
      run=results?.[0];
    }catch{throw new ReportNotSubmitted('unavailable');}
    if(!run?.success)throw new ReportNotSubmitted('unavailable');
    if((run.meta?.changes??0)!==1)throw new ReportNotSubmitted('rate_limited');
    return {submitted:false,approval_required:true,category:kind,sanitized_description:clean.text,removed:clean.removed,
      approval_token:token,approval_expires_in_seconds:APPROVAL_TTL_MS/1000,
      will_attach:['this request id','up to 10 recent sanitized diagnostic codes for this account (no health data)'],
      next_step:'Show sanitized_description to the member. Only if they approve it, call report_issue again with the same category and description and this approval_token. No report exists yet.'};
  }
  if(typeof args.approval_token!=='string'||!APPROVAL_RE.test(args.approval_token))throw new ReportNotSubmitted('approval_invalid');
  const tokenHash=await sha256Hex(args.approval_token);
  let approved;
  try{approved=await db.prepare(APPROVAL_OK).bind(tokenHash,userId,key,now).first();}catch{throw new ReportNotSubmitted('unavailable');}
  if(!approved)throw new ReportNotSubmitted('approval_invalid');
  if(!await activeMembership(db,userId))throw new ReportNotSubmitted('unavailable');
  const evidence=await memberEvidence(db,userId,since);
  const subsystems=[...new Set(evidence.map(e=>e.subsystem))].join(',').slice(0,200);
  const at=new Date(now).toISOString();
  let run;
  try{
    // One transaction: the insert re-checks the approval, the approval is
    // consumed only if this exact submission was stored, then retention runs.
    const results=await db.batch([
      db.prepare(INSERT).bind(userId,newReference(),kind,severityFor(kind,evidence),clean.text,key,requestId,
        JSON.stringify(evidence),subsystems,at,at.slice(0,10),new Date(now-LIMITS.perMemberIntervalMs).toISOString(),
        LIMITS.perMemberPerDay,LIMITS.serverPerDay,tokenHash,now),
      db.prepare(CONSUME).bind(tokenHash,userId,key,requestId,at),
      ...retentionStatements(db,now)
    ]);
    run=results?.[0];
  }catch{throw new ReportNotSubmitted('unavailable');}
  if(!run?.success)throw new ReportNotSubmitted('unavailable');
  if((run.meta?.changes??0)!==1)throw new ReportNotSubmitted('rate_limited');
  // Confirmation is the stored row itself, read back for this member and request.
  let row;
  try{row=await db.prepare(CONFIRM_SQL).bind(userId,key,requestId,at).first();}catch{row=null;}
  if(!row||!/^WL-[A-Z0-9]{8}$/.test(row.reference))throw new ReportNotSubmitted('unavailable');
  return {submitted:true,reference:row.reference,duplicate:row.occurrences>1,status:row.status,
    message:row.occurrences>1?`This matches an earlier report, ${row.reference}. It was updated, not duplicated.`:
      `Report ${row.reference} was saved for the server owner to review.`};
}
const LIST_SQL='SELECT reference,user_id,category,severity,status,description,request_id,evidence_json,subsystems,'+
  'occurrences,created_at,updated_at FROM issue_reports WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR category=?2) '+
  'ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4';
const COUNTS_SQL='SELECT status,COUNT(*) AS n FROM issue_reports GROUP BY status';
// Server-wide sanitized diagnostics for the last day: counts only, no member ids.
const DIAG_SQL='SELECT category,subsystem,code,outcome,SUM(count) AS n,MAX(last_at) AS last_at FROM diagnostic_events '+
  'WHERE last_at>?1 AND outcome<>\'success\' GROUP BY category,subsystem,code,outcome ORDER BY n DESC LIMIT 25';
export async function reviewIssueReports(db,userId,args,{env,now=Date.now()}={}){
  if(!issueReportsEnabled(env)||!isOwner(env,userId))throw new ReportNotSubmitted('unavailable');
  try{await db.batch(retentionStatements(db,now));}catch{/* retention is retried on the next write */}
  const rows=(await db.prepare(LIST_SQL).bind(args.status??null,args.category??null,args.limit??10,args.offset??0).all())?.results??[];
  const counts=Object.fromEntries(STATUSES.map(s=>[s,0]));
  for(const r of (await db.prepare(COUNTS_SQL).all())?.results??[])if(Object.hasOwn(counts,r.status))counts[r.status]=r.n;
  let diagnostics=[];
  try{diagnostics=((await db.prepare(DIAG_SQL).bind(new Date(now-86400000).toISOString()).all())?.results??[])
    .map(r=>({category:r.category,subsystem:r.subsystem,code:r.code,outcome:r.outcome,count:r.n,last_at:r.last_at}));}catch{}
  return {counts,reports:rows.map(r=>({reference:r.reference,member_id:r.user_id,category:r.category,severity:r.severity,
    status:r.status,subsystems:r.subsystems?r.subsystems.split(','):[],occurrences:r.occurrences,description:r.description,
    request_id:r.request_id,evidence:JSON.parse(r.evidence_json),created_at:r.created_at,updated_at:r.updated_at})),
    diagnostics_last_24h:diagnostics,
    note:'Sanitized reports and codes only. Status changes are manual; nothing here fixes, deploys, rotates or changes permissions.'};
}
export async function updateIssueReport(db,userId,args,{env,now=Date.now()}={}){
  if(!issueReportsEnabled(env)||!isOwner(env,userId))throw new ReportNotSubmitted('unavailable');
  const result=await db.prepare('UPDATE issue_reports SET status=?2,updated_at=?3 WHERE reference=?1')
    .bind(args.reference,args.status,new Date(now).toISOString()).run();
  if(!result?.success||(result.meta?.changes??0)!==1)throw new ReportNotSubmitted('not_found');
  return {reference:args.reference,status:args.status,updated:true};
}
export const reportIssueTool=Object.freeze({
  name:'report_issue',
  description:'Report a problem with WHOOP Lens to the server owner. First call without approval_token to get the cleaned text and an approval_token; show the text to the member and call again with the same category, description and approval_token only if they approve. Numbers, links, addresses and credentials are removed. A reference is returned only after the report is saved.',
  inputSchema:{type:'object',properties:{
    category:{type:'string',enum:[...KINDS]},
    description:{type:'string',minLength:1,maxLength:MAX_INPUT,description:'What went wrong, in plain words. Do not include health values or personal details.'},
    approval_token:{type:'string',pattern:'^ira_[A-Za-z0-9_-]{43}$',description:'From the preview call, only after the member approved that cleaned text. Expires after 10 minutes.'}
  },required:['category','description'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
});
export const ownerIssueTools=Object.freeze([
  Object.freeze({name:'review_issue_reports',
    description:'Owner only. List member issue reports and sanitized diagnostic counts.',
    inputSchema:{type:'object',properties:{status:{type:'string',enum:[...STATUSES]},category:{type:'string',enum:[...KINDS]},
      limit:{type:'integer',minimum:1,maximum:25},offset:{type:'integer',minimum:0,maximum:1000}},additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}),
  Object.freeze({name:'update_issue_report',
    description:'Owner only. Set a report status (new, acknowledged, resolved, recurring). Changes nothing else.',
    inputSchema:{type:'object',properties:{reference:{type:'string',pattern:'^WL-[A-Z0-9]{8}$'},status:{type:'string',enum:[...STATUSES]}},
      required:['reference','status'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}})
]);
export function issueToolsFor(env,userId){
  if(!issueReportsEnabled(env))return [];
  return isOwner(env,userId)?[reportIssueTool,...ownerIssueTools]:[reportIssueTool];
}
export function issueArguments(name,args){
  const keys=Object.keys(args);
  const only=allowed=>keys.every(k=>allowed.includes(k));
  if(name==='report_issue'){
    if(!only(['category','description','approval_token']))return null;
    if(!KINDS.includes(args.category))return null;
    if(typeof args.description!=='string'||args.description.length<1||args.description.length>MAX_INPUT)return null;
    if(args.approval_token!==undefined&&(typeof args.approval_token!=='string'||!APPROVAL_RE.test(args.approval_token)))return null;
    return {category:args.category,description:args.description,approval_token:args.approval_token};
  }
  if(name==='review_issue_reports'){
    if(!only(['status','category','limit','offset']))return null;
    if(args.status!==undefined&&!STATUSES.includes(args.status))return null;
    if(args.category!==undefined&&!KINDS.includes(args.category))return null;
    if(args.limit!==undefined&&!(Number.isSafeInteger(args.limit)&&args.limit>=1&&args.limit<=25))return null;
    if(args.offset!==undefined&&!(Number.isSafeInteger(args.offset)&&args.offset>=0&&args.offset<=1000))return null;
    return {status:args.status,category:args.category,limit:args.limit,offset:args.offset};
  }
  if(name==='update_issue_report'){
    if(!only(['reference','status']))return null;
    if(typeof args.reference!=='string'||!/^WL-[A-Z0-9]{8}$/.test(args.reference))return null;
    if(!STATUSES.includes(args.status))return null;
    return {reference:args.reference,status:args.status};
  }
  return null;
}
