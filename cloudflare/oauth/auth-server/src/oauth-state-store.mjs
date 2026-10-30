import {OAuthError} from '@cloudflare/workers-oauth-provider';
// Request-scoped adapter. Never cache this object or share its revision map.
// D1 without Sessions uses the primary; do not replace DB with a replica session.
export class OAuthStateStore {
 constructor(db,{now=()=>Date.now()}={}){if(!db?.prepare)throw Error('OAuth state DB unavailable');this.db=db;this.now=now;this.seen=new Map();}
 conflict(){throw new OAuthError('temporarily_unavailable',{statusCode:503,description:'Authorization state changed; retry the request'});}
 grantFor(key){return key.startsWith('token:')?'grant:'+key.slice(6,key.lastIndexOf(':')):null;}
 async read(key){
  // A single primary read binds access-token validity to the live grant.
  const row=await this.db.prepare('SELECT s.* FROM oauth_security_state s WHERE s.key=?1 AND (s.grant_key IS NULL OR EXISTS (SELECT 1 FROM oauth_security_state g WHERE g.key=s.grant_key AND g.value IS NOT NULL AND (g.expires_at IS NULL OR g.expires_at>?2)))')
   .bind(key,Math.floor(this.now()/1000)).first();
  this.seen.set(key,row?.revision??0);
  return row;
 }
 async get(key,type){
  const row=await this.read(key),now=Math.floor(this.now()/1000);
  if(!row||row.value===null||(row.expires_at!==null&&row.expires_at<=now))return null;
  return (type==='json'||type?.type==='json')?JSON.parse(row.value):row.value;
 }
 async put(key,value,options={}){
  if(typeof value!=='string')throw Error('OAuth state must be text');
  const now=Math.floor(this.now()/1000),expires=options.expiration??(options.expirationTtl?now+options.expirationTtl:null),grant=this.grantFor(key);
  if(!this.seen.has(key)){
   if(key.startsWith('grant:')||key.startsWith('transaction:'))this.seen.set(key,0);
   else await this.read(key);
  }
  const revision=this.seen.get(key);
  const grantRevision=grant?this.seen.get(grant):null;
  // Token publication must follow this request's successful grant CAS.
  if(grant&&grantRevision===undefined)this.conflict();
  const result=await this.db.prepare(
   'INSERT INTO oauth_security_state(key,value,revision,expires_at,metadata_json,grant_key) '+
   'SELECT ?1,?2,1,?3,?4,?5 WHERE (?5 IS NULL OR EXISTS (SELECT 1 FROM oauth_security_state g WHERE g.key=?5 AND g.value IS NOT NULL AND g.revision=?7 AND (g.expires_at IS NULL OR g.expires_at>?8))) '+
   'ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=oauth_security_state.revision+1,expires_at=excluded.expires_at,metadata_json=excluded.metadata_json,grant_key=excluded.grant_key WHERE oauth_security_state.revision=?6'
  ).bind(key,value,expires,options.metadata?JSON.stringify(options.metadata):null,grant,revision,grantRevision??0,now).run();
  if(result.meta?.changes!==1)this.conflict();
  this.seen.set(key,revision+1);
 }
 async delete(key){
  if(key.startsWith('transaction:')){
   const revision=this.seen.get(key);if(!revision)this.conflict();
   const result=await this.db.prepare('UPDATE oauth_security_state SET value=NULL,revision=revision+1,metadata_json=NULL WHERE key=?1 AND revision=?2 AND value IS NOT NULL AND expires_at>?3')
    .bind(key,revision,Math.floor(this.now()/1000)).run();
   if(result.meta?.changes!==1)this.conflict();this.seen.set(key,revision+1);return;
  }
  // Unconditional revocation advances a durable tombstone. A delayed writer
  // cannot recreate a deleted grant using its old revision (including zero).
  await this.db.prepare('INSERT INTO oauth_security_state(key,value,revision,expires_at) VALUES(?1,NULL,1,NULL) ON CONFLICT(key) DO UPDATE SET value=NULL,revision=revision+1,metadata_json=NULL,expires_at=NULL').bind(key).run();
  this.seen.delete(key);
 }
 async list({prefix='',cursor='',limit=1000}={}){
  const last=cursor?new TextDecoder().decode(Uint8Array.from(atob(cursor),c=>c.charCodeAt(0))):'';
  const size=Math.max(1,Math.min(1000,limit)),now=Math.floor(this.now()/1000);
  const result=await this.db.prepare('SELECT s.key,s.expires_at,s.metadata_json FROM oauth_security_state s WHERE substr(s.key,1,length(?1))=?1 AND s.key>?2 AND s.value IS NOT NULL AND (s.expires_at IS NULL OR s.expires_at>?3) AND (s.grant_key IS NULL OR EXISTS(SELECT 1 FROM oauth_security_state g WHERE g.key=s.grant_key AND g.value IS NOT NULL AND (g.expires_at IS NULL OR g.expires_at>?3))) ORDER BY s.key LIMIT ?4').bind(prefix,last,now,size+1).all();
  const rows=result.results,more=rows.length>size,page=rows.slice(0,size);
  return {keys:page.map(r=>({name:r.key,...(r.expires_at===null?{}:{expiration:r.expires_at}),...(r.metadata_json?{metadata:JSON.parse(r.metadata_json)}:{})})),list_complete:!more,cursor:more?btoa(String.fromCharCode(...new TextEncoder().encode(page.at(-1).key))):''};
 }
}
export function oauthStateEnv(env){
 // Explicit migration switch; no fallback can revive legacy KV credentials.
 if(env?.OAUTH_STATE_STORE!=='d1')return env;
 return {...env,OAUTH_KV:new OAuthStateStore(env.DB)};
}
