// The former-member deletion runbook must name every table that stores a
// member id, so a new migration cannot silently leave data behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

const DIR=new URL('../cloudflare/migrations/',import.meta.url);
const runbook=readFileSync(new URL('./runbooks/former-member-deletion.md',import.meta.url),'utf8').replaceAll('\r\n','\n');

test('runbook deletes from every table keyed by a member id',()=>{
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(f,DIR),'utf8'));
  const keyed=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'").all().map(r=>r.name)
    .filter(t=>db.prepare(`PRAGMA table_info(${t})`).all().some(c=>c.name==='user_id'||c.name==='user_key'));
  assert.ok(keyed.length>10);
  for(const t of keyed)assert.match(runbook,new RegExp(`DELETE FROM ${t} WHERE`),t);
  db.close();
});

test('runbook keeps requests private and parents last',()=>{
  assert.match(runbook,/Never discuss the request[^.]*public GitHub issue/);
  assert.ok(runbook.indexOf('DELETE FROM identity_links')>runbook.indexOf('DELETE FROM whoop_members'));
  assert.ok(runbook.lastIndexOf('DELETE FROM')===runbook.indexOf('DELETE FROM identity_links'),'identity_links is deleted last');
});

// Seed one row per member-keyed table for the target and for another member,
// then run the runbook's delete block: every target row must go and every
// other-member row must stay. CHECKs are relaxed only while seeding synthetic
// filler values; NOT NULL, UNIQUE and foreign keys stay enforced.
function migrated(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(f,DIR),'utf8'));
  return db;
}
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'").all().map(r=>r.name);
const cols=(db,t)=>db.prepare(`PRAGMA table_info(${t})`).all();
const owner=(db,t)=>{const c=cols(db,t).map(x=>x.name);return c.includes('user_id')?'user_id':c.includes('user_key')?'user_key':(t.startsWith('ai_')&&c.includes('scope'))?'scope':null;};
const ownerValue=(col,u)=>col==='scope'?'user:'+u:u;
function seed(db,u,n){
  const pending=tables(db).filter(t=>owner(db,t)&&!['identity_links','whoop_members'].includes(t));
  for(let pass=0;pending.length&&pass<10;pass++){
    for(const t of [...pending]){
      const deps=db.prepare(`PRAGMA foreign_key_list(${t})`).all().map(f=>f.table).filter(x=>x!==t);
      if(deps.some(d=>pending.includes(d)))continue;
      const col=owner(db,t),names=[],vals=[];
      for(const c of cols(db,t)){
        if(c.name===col){names.push(c.name);vals.push(ownerValue(col,u));continue;}
        if(c.name==='user_id'){names.push(c.name);vals.push(u);continue;}
        if(c.pk&&/INT/i.test(c.type))continue;
        if(!c.notnull&&!c.pk)continue;
        if(c.dflt_value!==null&&!c.pk)continue;
        names.push(c.name);vals.push(/INT|REAL|NUM/i.test(c.type)?n:`${t}-${c.name}-${n}`);
      }
      db.prepare(`INSERT INTO ${t}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...vals);
      pending.splice(pending.indexOf(t),1);
    }
  }
  assert.deepEqual(pending,[],'every member-keyed table seeded');
}
const countFor=(db,t,u)=>{const c=owner(db,t);return db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(ownerValue(c,u)).n;};

const U='0b0b0b0b-0000-4000-8000-00000000000b',OTHER='0c0c0c0c-0000-4000-8000-00000000000c';
const ACCOUNT=['member_life_schedule','identity_links','whoop_members','access_identity_links','whoop_waitlist','whoop_member_request_budget'];
const block=name=>runbook.split(name)[1].match(/```sql\n([\s\S]*?)```/)[1].replaceAll(':U',U);
function seeded(active){
  const db=migrated();
  for(const id of [U,OTHER]){
    db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'cloudflare_access',?)").run(id,id);
    db.prepare('INSERT INTO whoop_members(user_id,active) VALUES(?,?)').run(id,active);
  }
  db.exec('PRAGMA ignore_check_constraints=ON');
  seed(db,U,1);seed(db,OTHER,2);
  db.exec('PRAGMA ignore_check_constraints=OFF');
  db.prepare('UPDATE access_identity_links SET enabled=?').run(active);
  const keyed=tables(db).filter(t=>owner(db,t));
  for(const t of keyed)assert.equal(countFor(db,t,U),1,'seeded '+t);
  return {db,keyed};
}
// Same queries the auth worker (upstream.mjs) and resource worker (storage.mjs ACTIVE_MEMBER_SQL) use.
const canSignIn=(db,u)=>!!db.prepare('SELECT user_id FROM access_identity_links WHERE user_id=?1 AND enabled=1').get(u)&&
  !!db.prepare("SELECT m.user_id FROM whoop_members m INNER JOIN identity_links i ON i.user_id=m.user_id WHERE m.user_id=?1 AND m.active=1 AND i.identity_provider='cloudflare_access' AND length(i.provider_subject)>0").get(u);

test('health-data-only mode removes health data but keeps sign-in mappings and explicit preferences (foreign keys on)',()=>{
  const {db,keyed}=seeded(1);
  assert.ok(canSignIn(db,U));
  db.exec('BEGIN');db.exec(block('### 4a.'));db.exec('COMMIT');
  for(const t of keyed){
    assert.equal(countFor(db,t,U),ACCOUNT.includes(t)?1:0,(ACCOUNT.includes(t)?'kept ':'deleted ')+t);
    assert.equal(countFor(db,t,OTHER),1,'other member kept in '+t);
  }
  assert.ok(canSignIn(db,U),'member can still sign in');
  assert.ok(canSignIn(db,OTHER));
  const counts=block('## 3.');
  assert.ok(db.prepare(counts).all().every(r=>Object.values(r)[1]===0));
  db.close();
});

test('full account deletion removes every member-keyed row for the target only (foreign keys on)',()=>{
  const {db,keyed}=seeded(0);
  db.exec('BEGIN');db.exec(block('### 4a.'));db.exec(block('### 4b.'));db.exec('COMMIT');
  for(const t of keyed){
    assert.equal(countFor(db,t,U),0,'target rows deleted from '+t);
    assert.equal(countFor(db,t,OTHER),1,'other member kept in '+t);
  }
  assert.ok(db.prepare(block('## 3.')).all().every(r=>Object.values(r)[1]===0));
  db.close();
});

test('health-data-only block never touches account or sign-in tables',()=>{
  const a=block('### 4a.');
  for(const t of ACCOUNT)assert.doesNotMatch(a,new RegExp(`DELETE FROM ${t} `),t);
  assert.match(runbook,/never default to full deletion/);
});

test('identity verification never rests on a From address alone',()=>{
  assert.match(runbook,/matching From address is never\s+enough/);
  assert.match(runbook,/one-time code/);
  assert.doesNotMatch(runbook,/request comes\s+from the email address used for the seat request/);
});

function seedOAuth(db){
 const targetGrant='grant:'+U+':live';
 const rows=[
  [targetGrant,'{"synthetic":"grant"}',3,9999999999,'{"synthetic":"metadata"}',null],
  ['token:'+U+':live:access','{"synthetic":"token"}',2,9999999999,'{}',targetGrant],
  ['grant:'+U+':revoked',null,9,null,null,null],
  ['token:'+U+':revoked:access',null,4,null,null,'grant:'+U+':revoked'],
  ['grant:'+OTHER+':live','{"other":true}',1,null,null,null],
  ['token:'+OTHER+':live:access','{"other":true}',1,null,null,'grant:'+OTHER+':live'],
  ['grant:'+U+'-suffix:live','{"nearPrefix":true}',1,null,null,null],
  ['client:shared','{"shared":true}',1,null,null,null],
  ['transaction:opaque','sealed-synthetic',1,9999999999,null,null]
 ];
 for(const row of rows)db.prepare('INSERT INTO oauth_security_state(key,value,revision,expires_at,metadata_json,grant_key) VALUES(?,?,?,?,?,?)').run(...row);
}
const oauthRows=db=>db.prepare('SELECT * FROM oauth_security_state ORDER BY key').all();
const targetOAuth=row=>row.key.startsWith('grant:'+U+':')||row.key.startsWith('token:'+U+':');
test('health-data-only SQL preserves D1 OAuth credentials and unrelated state',()=>{
 const {db}=seeded(1);try{
  seedOAuth(db);const before=oauthRows(db);
  db.exec('BEGIN');db.exec(block('### 4a.'));db.exec('COMMIT');
  assert.deepEqual(oauthRows(db),before);
  assert.ok(canSignIn(db,U));
 }finally{db.close();}
});
test('full deletion clears only exact-owner D1 OAuth payloads and retains advancing tombstones',()=>{
 const {db}=seeded(0);try{
  seedOAuth(db);const before=oauthRows(db);
  db.exec('BEGIN');db.exec(block('### 4a.'));db.exec(block('### 4b.'));db.exec('COMMIT');
  const after=oauthRows(db);assert.equal(after.length,before.length,'no D1 revocation marker is deleted');
  for(let i=0;i<before.length;i++){
   const row=after[i],old=before[i];assert.equal(row.key,old.key);
   if(targetOAuth(old)){
    assert.equal(row.value,null);assert.equal(row.metadata_json,null);assert.equal(row.expires_at,null);
    assert.equal(row.revision,old.revision+1);
   }else assert.deepEqual(row,old,'other member, prefix lookalike, client and transaction remain unchanged');
  }
  assert.equal(db.prepare('SELECT count(*) n FROM oauth_security_state WHERE value IS NOT NULL AND (substr(key,1,length(?))=? OR substr(key,1,length(?))=?)').get('grant:'+U+':','grant:'+U+':','token:'+U+':','token:'+U+':').n,0);
 }finally{db.close();}
});
test('runbook distinguishes both OAuth stores and forbids deleting D1 revocation markers',()=>{
 assert.match(runbook,/OAUTH_STATE_STORE=d1/);
 assert.match(block('### 4b.'),/UPDATE oauth_security_state/);
 assert.match(block('### 4b.'),/revision=revision\+1/);
 assert.doesNotMatch(runbook,/DELETE FROM oauth_security_state/);
 assert.doesNotMatch(block('### 4a.'),/oauth_security_state/);
 assert.match(runbook,/in-flight authorization\/credential writers/);
});
