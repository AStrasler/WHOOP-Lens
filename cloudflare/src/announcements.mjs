// Owner-only service announcements. Off unless ANNOUNCEMENTS_ENABLED is exactly
// "true". Members receive only notices that are currently active and addressed
// to them or to everyone. Management (create, edit, schedule, expire, cancel,
// target) is enforced here, not by hiding a button. No health data, names, or
// emails are stored. Push notifications are not sent.
import {readBounded} from './bounded-body.mjs';
import {activeMembership} from './storage.mjs';

export const KINDS=Object.freeze(['maintenance','outage','restoration','update']);
export const AUDIENCES=Object.freeze(['all','members']);
const CREATE_STATUSES=Object.freeze(['draft','scheduled','active']);
const STATUSES=Object.freeze(['draft','scheduled','active','expired','cancelled']);
const ACTIONS=Object.freeze(['save','schedule','publish','expire','cancel']);
const MEMBER_FIELDS=Object.freeze(['id','kind','title','body','starts_at','expires_at']);
const MAX_TITLE=120,MAX_BODY=1000,MAX_TARGETS=20,MAX_NOTICES=20,MAX_MANAGE=50,MAX_BODY_BYTES=8000;
const ID_RE=/^[0-9a-f]{32}$/;
const ISO_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// Notice text is shown to members. Reject anything that would publish an
// identity, a credential, a link, or a health measurement.
const PRIVATE_TEXT=[
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:bearer|basic)\s+\S+/i,
  /https?:\/\//i,
  /\b(?:recovery_score|heart_rate|resting_heart_rate|hrv|spo2|strain_score|sleep_score)\b/i,
  /\bheart\s+rate\b/i,
  /\brecovery\s+score\b/i,
  /\d{8,}/
];

export function announcementsEnabled(env){return env?.ANNOUNCEMENTS_ENABLED==='true';}
export function isAnnouncementOwner(env,userId){
  const owner=env?.WHOOP_LENS_DEVELOPER_USER_ID;
  return typeof owner==='string'&&owner.length>0&&owner===userId;
}
export class AnnouncementRejected extends Error{
  constructor(reason){
    super({
      disabled:'Service announcements are turned off. Nothing was changed.',
      forbidden:'Not allowed.',
      invalid:'That announcement could not be saved.',
      not_found:'No matching announcement was found.',
      unavailable:'Service announcements are not available right now.'
    }[reason]??'That announcement could not be saved.');
    this.name='AnnouncementRejected';
    this.reason=reason;
  }
}
const iso=ms=>new Date(ms).toISOString();
function instant(value){
  if(typeof value!=='string'||!ISO_RE.test(value))return null;
  const time=Date.parse(value);
  return Number.isFinite(time)?new Date(time).toISOString():null;
}
function noticeText(value,max){
  if(typeof value!=='string')return null;
  const text=value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(text.length<1||text.length>max)return null;
  if(PRIVATE_TEXT.some(re=>re.test(text)))return null;
  return text;
}
function memberIdList(value){
  if(!Array.isArray(value)||value.length<1||value.length>MAX_TARGETS)return null;
  const ids=[];
  for(const item of value){
    if(typeof item!=='string')return null;
    const id=item.toLowerCase();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))return null;
    if(!ids.includes(id))ids.push(id);
  }
  return ids;
}
function own(obj,key){return Object.prototype.hasOwnProperty.call(obj,key);}
function isObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function newId(){
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function memberView(row){
  return {id:row.id,kind:row.kind,title:row.title,body:row.body,starts_at:row.starts_at,expires_at:row.expires_at};
}
function ownerView(row){
  return {id:row.id,kind:row.kind,title:row.title,body:row.body,audience:row.audience,
    member_ids:row.member_ids,starts_at:row.starts_at,expires_at:row.expires_at,status:row.status,
    created_at:row.created_at,updated_at:row.updated_at};
}
function timingOk(row,nowIso){
  if(!row.starts_at)return false;
  // Expiring or cancelling a notice that has not started yet is allowed.
  if(row.status!=='expired'&&row.status!=='cancelled'&&row.expires_at&&row.expires_at<=row.starts_at)return false;
  if(row.status==='scheduled'&&row.starts_at<=nowIso)return false;
  if(row.status==='active'&&row.starts_at>nowIso)return false;
  if(row.status==='active'&&row.expires_at&&row.expires_at<=nowIso)return false;
  if(row.audience==='members'&&row.member_ids.length<1)return false;
  if(row.audience==='all'&&row.member_ids.length>0)return false;
  return true;
}
async function membersActive(db,ids){
  for(const id of ids){
    try{if(!await activeMembership(db,id))return false;}
    catch{return false;}
  }
  return true;
}
function sameMembers(left,right){
  if(left.length!==right.length)return false;
  const a=left.slice().sort();
  const b=right.slice().sort();
  return a.every((id,index)=>id===b[index]);
}
function recipientsChanged(existing,next){
  return existing.audience!==next.audience||!sameMembers(existing.member_ids,next.member_ids);
}
const TARGETS_SQL='SELECT user_id FROM service_announcement_targets WHERE announcement_id=?1 ORDER BY user_id';
async function withTargets(db,row){
  const targets=(await db.prepare(TARGETS_SQL).bind(row.id).all())?.results??[];
  return {...row,member_ids:targets.map(t=>t.user_id)};
}
async function readOne(db,id){
  const row=await db.prepare('SELECT id,kind,title,body,audience,starts_at,expires_at,status,created_at,updated_at FROM service_announcements WHERE id=?1').bind(id).first();
  return row?withTargets(db,row):null;
}
async function writeRow(db,row){
  const statements=[
    db.prepare('INSERT INTO service_announcements(id,kind,title,body,audience,starts_at,expires_at,status,created_at,updated_at) '+
      'VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,'+
      'body=excluded.body,audience=excluded.audience,starts_at=excluded.starts_at,expires_at=excluded.expires_at,'+
      'status=excluded.status,updated_at=excluded.updated_at').bind(
      row.id,row.kind,row.title,row.body,row.audience,row.starts_at,row.expires_at,row.status,row.created_at,row.updated_at),
    db.prepare('DELETE FROM service_announcement_targets WHERE announcement_id=?1').bind(row.id)
  ];
  if(row.audience==='members'){
    for(const id of row.member_ids)
      statements.push(db.prepare('INSERT INTO service_announcement_targets(announcement_id,user_id) VALUES(?1,?2)').bind(row.id,id));
  }
  try{await db.batch(statements);}
  catch{throw new AnnouncementRejected('unavailable');}
}
function audienceOf(input,fallback){
  const audience=input.audience??fallback?.audience;
  if(!AUDIENCES.includes(audience))return null;
  let member_ids;
  if(audience==='all'){
    if(own(input,'member_ids')&&!(Array.isArray(input.member_ids)&&input.member_ids.length===0))return null;
    member_ids=[];
  }else if(own(input,'member_ids')){
    member_ids=memberIdList(input.member_ids);
    if(!member_ids)return null;
  }else if(fallback?.audience==='members')member_ids=fallback.member_ids.slice();
  else return null;
  return {audience,member_ids};
}
export function parseCreate(input,now){
  if(!isObject(input))return null;
  const allowed=['kind','title','body','audience','member_ids','starts_at','expires_at','status'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))return null;
  const kind=input.kind,title=noticeText(input.title,MAX_TITLE),body=noticeText(input.body,MAX_BODY);
  const starts_at=instant(input.starts_at);
  const status=input.status??'draft';
  if(!KINDS.includes(kind)||!title||!body||!starts_at||!CREATE_STATUSES.includes(status))return null;
  let expires_at=null;
  if(own(input,'expires_at')&&input.expires_at!=null){
    expires_at=instant(input.expires_at);
    if(!expires_at)return null;
  }
  const audience=audienceOf(input,null);
  if(!audience)return null;
  const nowIso=iso(now);
  const row={kind,title,body,starts_at,expires_at,status,...audience};
  return timingOk(row,nowIso)?row:null;
}
function applyUpdate(existing,input,nowIso){
  const action=input.action??'save';
  if(!ACTIONS.includes(action))return null;
  const next={...existing,member_ids:existing.member_ids.slice(),updated_at:nowIso};
  if(action==='expire'){
    next.status='expired';
    next.expires_at=nowIso;
    return next;
  }
  if(action==='cancel'){next.status='cancelled';return next;}
  if(own(input,'kind')){if(!KINDS.includes(input.kind))return null;next.kind=input.kind;}
  if(own(input,'title')){const title=noticeText(input.title,MAX_TITLE);if(!title)return null;next.title=title;}
  if(own(input,'body')){const body=noticeText(input.body,MAX_BODY);if(!body)return null;next.body=body;}
  if(own(input,'starts_at')){const starts=instant(input.starts_at);if(!starts)return null;next.starts_at=starts;}
  if(own(input,'expires_at')){
    if(input.expires_at==null)next.expires_at=null;
    else{const expires=instant(input.expires_at);if(!expires)return null;next.expires_at=expires;}
  }
  if(own(input,'audience')||own(input,'member_ids')){
    const audience=audienceOf(input,existing);
    if(!audience)return null;
    next.audience=audience.audience;next.member_ids=audience.member_ids;
  }
  if(action==='schedule'){
    if(!own(input,'starts_at'))return null;
    next.status='scheduled';
  }else if(action==='publish'){
    next.status='active';
    if(next.starts_at>nowIso)next.starts_at=nowIso;
  }else if(own(input,'status')){
    if(!CREATE_STATUSES.includes(input.status))return null;
    next.status=input.status;
  }
  return timingOk(next,nowIso)?next:null;
}
export function parseUpdate(input){
  if(!isObject(input))return null;
  const allowed=['id','action','kind','title','body','audience','member_ids','starts_at','expires_at','status'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))return null;
  if(typeof input.id!=='string'||!ID_RE.test(input.id))return null;
  if(input.action!==undefined&&!ACTIONS.includes(input.action))return null;
  return input;
}
async function guardOwner(db,userId,env){
  if(!announcementsEnabled(env))throw new AnnouncementRejected('disabled');
  if(!isAnnouncementOwner(env,userId))throw new AnnouncementRejected('forbidden');
  if(!db)throw new AnnouncementRejected('unavailable');
}
export async function createAnnouncement(db,userId,input,{env,now=Date.now()}={}){
  await guardOwner(db,userId,env);
  const parsed=parseCreate(input,now);
  if(!parsed)throw new AnnouncementRejected('invalid');
  if(parsed.audience==='members'&&!await membersActive(db,parsed.member_ids))throw new AnnouncementRejected('invalid');
  if(await outstandingCount(db)>=MAX_MANAGE)throw new AnnouncementRejected('invalid');
  const nowIso=iso(now);
  const row={id:newId(),...parsed,created_at:nowIso,updated_at:nowIso};
  await writeRow(db,row);
  const stored=await readOne(db,row.id);
  if(!stored)throw new AnnouncementRejected('unavailable');
  return ownerView(stored);
}
export async function updateAnnouncement(db,userId,input,{env,now=Date.now()}={}){
  await guardOwner(db,userId,env);
  const parsed=parseUpdate(input);
  if(!parsed)throw new AnnouncementRejected('invalid');
  let existing;
  try{existing=await readOne(db,parsed.id);}
  catch{throw new AnnouncementRejected('unavailable');}
  if(!existing)throw new AnnouncementRejected('not_found');
  const next=applyUpdate(existing,parsed,iso(now));
  if(!next)throw new AnnouncementRejected('invalid');
  // Membership is checked when recipients are added or changed. Expire, cancel,
  // and other edits still work after a targeted member becomes inactive.
  if(next.audience==='members'&&recipientsChanged(existing,next)&&!await membersActive(db,next.member_ids))
    throw new AnnouncementRejected('invalid');
  // A retired notice does not count toward the cap until it is published or rescheduled.
  if(!isOutstanding(existing.status)&&isOutstanding(next.status)&&await outstandingCount(db)>=MAX_MANAGE)
    throw new AnnouncementRejected('invalid');
  await writeRow(db,next);
  const stored=await readOne(db,next.id);
  if(!stored)throw new AnnouncementRejected('unavailable');
  return ownerView(stored);
}
const VISIBLE_SQL='SELECT id,kind,title,body,starts_at,expires_at FROM service_announcements a '+
  "WHERE status IN ('scheduled','active') AND starts_at<=?1 AND (expires_at IS NULL OR expires_at>?1) AND ("+
  "audience='all' OR EXISTS (SELECT 1 FROM service_announcement_targets t WHERE t.announcement_id=a.id AND t.user_id=?2)) "+
  'ORDER BY starts_at DESC LIMIT '+MAX_NOTICES;
export async function listMemberAnnouncements(db,userId,{env,now=Date.now()}={}){
  if(!announcementsEnabled(env))return {enabled:false,announcements:[]};
  if(!db)throw new AnnouncementRejected('unavailable');
  try{
    const rows=(await db.prepare(VISIBLE_SQL).bind(iso(now),userId).all())?.results??[];
    return {enabled:true,announcements:rows.map(memberView),
      note:'Service notices only. No health data or account details.'};
  }catch{throw new AnnouncementRejected('unavailable');}
}
const OUTSTANDING=new Set(['draft','scheduled','active']);
const isOutstanding=status=>OUTSTANDING.has(status);
async function outstandingCount(db){
  try{return Number((await db.prepare(OUTSTANDING_COUNT_SQL).first())?.n??0);}
  catch{throw new AnnouncementRejected('unavailable');}
}
const MANAGE_COLUMNS='id,kind,title,body,audience,starts_at,expires_at,status,created_at,updated_at';
const OUTSTANDING_COUNT_SQL="SELECT COUNT(*) AS n FROM service_announcements WHERE status IN ('draft','scheduled','active')";
const OUTSTANDING_LIST_SQL='SELECT '+MANAGE_COLUMNS+" FROM service_announcements WHERE status IN ('draft','scheduled','active') ORDER BY updated_at DESC, id";
const RETIRED_LIST_SQL='SELECT '+MANAGE_COLUMNS+" FROM service_announcements WHERE status IN ('expired','cancelled') ORDER BY updated_at DESC, id LIMIT ?1";
export async function manageAnnouncements(db,userId,{env}={}){
  await guardOwner(db,userId,env);
  try{
    const outstanding=(await db.prepare(OUTSTANDING_LIST_SQL).all())?.results??[];
    const room=Math.max(0,MAX_MANAGE-outstanding.length);
    const retired=room?(await db.prepare(RETIRED_LIST_SQL).bind(room).all())?.results??[]:[];
    const rows=[...outstanding,...retired];
    const announcements=[];
    for(const row of rows)announcements.push(ownerView(await withTargets(db,row)));
    return {announcements};
  }catch(error){
    if(error instanceof AnnouncementRejected)throw error;
    throw new AnnouncementRejected('unavailable');
  }
}

export const listAnnouncementTool=Object.freeze({
  name:'list_service_announcements',
  description:'List service notices addressed to this member or to all members, and only while they are active. Service text only: no health data and no account details. The server does not push chat messages.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
});
const noticeProps={
  kind:{type:'string',enum:[...KINDS]},
  title:{type:'string',minLength:1,maxLength:MAX_TITLE},
  body:{type:'string',minLength:1,maxLength:MAX_BODY,description:'Service text only. Do not include health data, names, emails, links, or account ids.'},
  audience:{type:'string',enum:[...AUDIENCES],description:'all members, or members listed by their existing pseudonymous member id.'},
  member_ids:{type:'array',maxItems:MAX_TARGETS,items:{type:'string',minLength:36,maxLength:36},
    description:'Pseudonymous member ids. Required when audience is members. Never names or emails.'},
  starts_at:{type:'string',description:'UTC timestamp, for example 2026-10-28T02:00:00.000Z.'},
  expires_at:{type:'string',description:'UTC timestamp. Omit or null for no expiry.'}
};
export const ownerAnnouncementTools=Object.freeze([
  Object.freeze({name:'create_service_announcement',
    description:'Owner only. Create a service announcement. Status draft is hidden, scheduled waits until starts_at, and active is visible once starts_at has passed. Do not include health data or identities in the text.',
    inputSchema:{type:'object',properties:{...noticeProps,status:{type:'string',enum:[...CREATE_STATUSES]}},
      required:['kind','title','body','audience','starts_at'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}),
  Object.freeze({name:'update_service_announcement',
    description:'Owner only. Edit, schedule, publish, expire, cancel, or retarget an announcement. action is save, schedule, publish, expire, or cancel.',
    inputSchema:{type:'object',properties:{id:{type:'string',minLength:32,maxLength:32},action:{type:'string',enum:[...ACTIONS]},
      ...noticeProps,status:{type:'string',enum:[...CREATE_STATUSES]}},required:['id'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}),
  Object.freeze({name:'manage_service_announcements',
    description:'Owner only. List every announcement, including drafts and expired notices, with pseudonymous target ids. No health data, names, or emails.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}})
]);
const OWNER_TOOL_NAMES=new Set(ownerAnnouncementTools.map(tool=>tool.name));
export function announcementToolsFor(env,userId){
  if(!announcementsEnabled(env))return [];
  return isAnnouncementOwner(env,userId)?[listAnnouncementTool,...ownerAnnouncementTools]:[listAnnouncementTool];
}
export function isAnnouncementTool(name){
  return name==='list_service_announcements'||OWNER_TOOL_NAMES.has(name);
}
export function announcementArguments(name,args){
  if(!isObject(args))return null;
  if(name==='list_service_announcements'||name==='manage_service_announcements')
    return Object.keys(args).length===0?{}:null;
  if(name==='create_service_announcement')return parseCreate(args,Date.now())?args:null;
  if(name==='update_service_announcement')return parseUpdate(args);
  return null;
}
export async function runAnnouncementTool(name,args,{db,userId,env,now=Date.now()}){
  if(name==='list_service_announcements')return listMemberAnnouncements(db,userId,{env,now});
  if(name==='create_service_announcement')return createAnnouncement(db,userId,args,{env,now});
  if(name==='update_service_announcement')return updateAnnouncement(db,userId,args,{env,now});
  if(name==='manage_service_announcements')return manageAnnouncements(db,userId,{env});
  throw new AnnouncementRejected('forbidden');
}
export const ANNOUNCEMENT_OWNER_TOOLS=Object.freeze([...OWNER_TOOL_NAMES]);

function json(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",'referrer-policy':'no-referrer'
  }});
}
function httpError(error){
  const status={forbidden:403,disabled:403,invalid:400,not_found:404,unavailable:503}[error.reason]??400;
  return json({error:error.message},status);
}
export async function announcementsHttp(request,env,userId){
  const url=new URL(request.url);
  const path=url.pathname;
  const memberGet=request.method==='GET'&&path==='/v1/announcements';
  const manageGet=request.method==='GET'&&path==='/v1/announcements/manage';
  const createPost=request.method==='POST'&&path==='/v1/announcements';
  const updatePost=request.method==='POST'&&path==='/v1/announcements/update';
  if(!memberGet&&!manageGet&&!createPost&&!updatePost)return json({error:'Unsupported method'},405);
  if(!announcementsEnabled(env)){
    if(memberGet)return json({enabled:false,announcements:[]});
    return json({error:'Service announcements are turned off. Nothing was changed.'},403);
  }
  try{
    if(memberGet)return json(await listMemberAnnouncements(env.DB,userId,{env}));
    if(manageGet)return json(await manageAnnouncements(env.DB,userId,{env}));
    if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
      return json({error:'That announcement could not be saved.'},400);
    const bounded=await readBounded(request,MAX_BODY_BYTES);
    if(bounded.error)return json({error:'That announcement could not be saved.'},400);
    let input;
    try{input=JSON.parse(bounded.text);}catch{return json({error:'That announcement could not be saved.'},400);}
    if(createPost)return json(await createAnnouncement(env.DB,userId,input,{env}),201);
    return json(await updateAnnouncement(env.DB,userId,input,{env}));
  }catch(error){
    if(error instanceof AnnouncementRejected)return httpError(error);
    return json({error:'Service announcements are not available right now.'},503);
  }
}
export const MEMBER_NOTICE_FIELDS=MEMBER_FIELDS;
export const ANNOUNCEMENT_STATUSES=STATUSES;
