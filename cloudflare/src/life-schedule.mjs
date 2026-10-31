import {activeMembership} from './storage.mjs';
import {readBounded} from './bounded-body.mjs';

export const LIFE_SCHEDULES=Object.freeze(['fixed','flexible','unpredictable']);
export const lifeScheduleEnabled=env=>env?.LIFE_SCHEDULE_ENABLED==='true';
export const effectiveLifeSchedule=value=>LIFE_SCHEDULES.includes(value)?value:'unpredictable';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class LifeScheduleRejected extends Error {
  constructor(status){super('Life Schedule is unavailable or the request is not allowed.');this.status=status;}
}
function verifiedId(userId){
  if(typeof userId!=='string'||!UUID.test(userId))throw new LifeScheduleRejected(403);
  return userId.toLowerCase();
}
async function guard(db,userId,env){
  if(!lifeScheduleEnabled(env))throw new LifeScheduleRejected(503);
  const id=verifiedId(userId);
  if(!await activeMembership(db,id))throw new LifeScheduleRejected(403);
  return id;
}
export async function readLifeSchedule(db,userId,{env}={}){
  const id=await guard(db,userId,env);
  const row=await db.prepare('SELECT life_schedule,revision FROM member_life_schedule WHERE user_id=?1').bind(id).first();
  const selected=LIFE_SCHEDULES.includes(row?.life_schedule);
  return {life_schedule:effectiveLifeSchedule(row?.life_schedule),explicit:selected,revision:selected?row.revision:null};
}
// No MCP write tool. Call only from authenticated settings HTTP.
export async function selectLifeSchedule(db,userId,input,{env,now=Date.now()}={}){
  const id=await guard(db,userId,env);
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).sort().join(',')!=='confirmation,life_schedule'||
    input.confirmation!=='user_selected_life_schedule'||!LIFE_SCHEDULES.includes(input.life_schedule))
    throw new LifeScheduleRejected(400);
  const revision=crypto.randomUUID();
  const result=await db.prepare(`INSERT INTO member_life_schedule(user_id,life_schedule,revision,updated_at)
    SELECT ?1,?2,?3,?4 WHERE EXISTS (
      SELECT 1 FROM whoop_members m INNER JOIN identity_links i ON i.user_id=m.user_id
      WHERE m.user_id=?1 AND m.active=1 AND i.identity_provider='cloudflare_access' AND length(i.provider_subject)>0)
    ON CONFLICT(user_id) DO UPDATE SET life_schedule=excluded.life_schedule,revision=excluded.revision,updated_at=excluded.updated_at`)
    .bind(id,input.life_schedule,revision,new Date(now).toISOString()).run();
  if(result?.meta?.changes!==1)throw new LifeScheduleRejected(403);
  return {life_schedule:input.life_schedule,explicit:true,revision};
}
function json(data,status=200){return Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",'referrer-policy':'no-referrer'}});}
export async function lifeScheduleHttp(request,env,userId){
  try{
    if(request.method==='GET')return json(await readLifeSchedule(env.DB,userId,{env}));
    if(request.method!=='PUT')return json({error:'Unsupported method'},405);
    const origin=request.headers.get('origin');
    if(origin&&origin!==new URL(request.url).origin)return json({error:'Disallowed origin'},403);
    if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return json({error:'JSON required'},415);
    const body=await readBounded(request,512);
    if(body.error)return json({error:'Invalid preference'},400);
    let input;try{input=JSON.parse(body.text);}catch{return json({error:'Invalid preference'},400);}
    return json(await selectLifeSchedule(env.DB,userId,input,{env}));
  }catch(error){return json({error:'Life Schedule is unavailable or the request is not allowed.'},error instanceof LifeScheduleRejected?error.status:503);}
}
