// Migrations 0015/0016 and their rollbacks never alter or delete existing
// members, credentials, consent, seat roles or any other pre-existing row or
// schema object. Synthetic rows only (placeholder ciphertext, no health data).
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {member} from "./audit-fixtures.mjs";

const dir=new URL("../migrations/",import.meta.url);
const files=readdirSync(dir).filter(f=>f.endsWith(".sql")).sort();
const NEW=["0015_member_whoop_request_budget.sql","0016_whoop_connection_generations.sql"];
const NEW_TABLES=["whoop_member_request_budget","whoop_connection_generations"];
const sql=f=>readFileSync(new URL(f,dir),"utf8");
const down=f=>readFileSync(new URL("../migration/rollback/"+f.replace(".sql",".down.sql"),import.meta.url),"utf8");
const OWNER=member(61),M1=member(62),M2=member(63),FORMER=member(64);

function seed(db){
  const run=(q,...v)=>db.prepare(q).run(...v);
  for(const id of [OWNER,M1,M2,FORMER])run("INSERT INTO identity_links(user_id,identity_provider,provider_subject,created_at) VALUES(?,'supabase',?,'2026-10-01 00:00:00')",id,"sub-"+id);
  for(const [id,active] of [[OWNER,1],[M1,1],[M2,1],[FORMER,0]])run("INSERT INTO whoop_members(user_id,active,approved_at,created_at) VALUES(?,?,'2026-10-02 00:00:00','2026-10-01 00:00:00')",id,active);
  // Seat roles as used: a developer seat and public seats (production has public only).
  for(const [id,role,kv] of [[OWNER,"developer","k2"],[M1,"public","v1"],[M2,"public","k2"]])
    run("INSERT INTO whoop_connections(user_id,expires_at,scope,updated_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,?,?,?)",
      id,"2026-12-01T00:00:00.000Z","offline read:recovery","2026-10-03 00:00:00","enc-access-"+id,"enc-refresh-"+id,kv,role);
  run("INSERT INTO access_identity_links(issuer,subject,user_id,enabled,approved_at) VALUES('https://whoop-lens.cloudflareaccess.com',?,?,1,'2026-10-02 00:00:00')","acc-"+M1,M1);
  run("INSERT INTO health_import_consent(user_id,purpose,granted_at,withdrawn_at) VALUES(?,'health_connect_file','2026-10-04 00:00:00',NULL)",M1);
  run("INSERT INTO health_import_consent(user_id,purpose,granted_at,withdrawn_at) VALUES(?,'health_connect_file','2026-10-04 00:00:00','2026-10-05 00:00:00')",M2);
  run("INSERT INTO flare_consent(user_id,storage,analysis,generation,updated_at) VALUES(?,1,1,'g1','2026-10-06 00:00:00')",M1);
  run("INSERT INTO flare_consent(user_id,storage,analysis,generation,updated_at) VALUES(?,1,0,'g2','2026-10-06 00:00:00')",M2);
  run("INSERT INTO whoop_credential_revocations(user_id,revoked_at) VALUES(?,'2026-10-07 00:00:00.123')",FORMER);
  run("INSERT INTO whoop_oauth_states(state_hash,user_id,expires_at) VALUES('h1',?,'2099-01-01T00:00:00Z')",M2);
  run("INSERT INTO seat_request_limits(bucket,count,expires_at) VALUES('b1',2,9999999999999)");
  run("INSERT INTO seat_request_delivery(email_hash,claim,status,expires_at) VALUES('e1','c1','sent',9999999999999)");
}
// Every pre-existing table's rows, plus every schema object (tables, indexes,
// triggers) other than the two new tables and their autoindexes.
function snapshot(db){
  const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .filter(o=>!NEW_TABLES.includes(o.tbl_name)&&o.name!=="d1_migrations");
  const rows={};
  for(const t of objects.filter(o=>o.type==="table"))rows[t.name]=db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all();
  return JSON.stringify({objects,rows});
}

test("0015/0016 up, re-run and rollback leave members, credentials, consent and seat roles byte-identical",()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    for(const f of files.filter(f=>!NEW.includes(f)))db.exec(sql(f));
    seed(db);
    const before=snapshot(db);
    const counts=()=>db.prepare("SELECT (SELECT COUNT(*) FROM whoop_members) m,(SELECT COUNT(*) FROM whoop_members WHERE active=1) a,(SELECT COUNT(*) FROM whoop_connections) c,"+
      "(SELECT COUNT(*) FROM whoop_connections WHERE seat_role='developer') dev,(SELECT COUNT(*) FROM health_import_consent) hc,(SELECT COUNT(*) FROM flare_consent) fc").get();
    const c0={...counts()};
    assert.deepEqual(c0,{m:4,a:3,c:3,dev:1,hc:2,fc:2});
    // Up (the production order: 0015, 0016, then the d1_migrations rows).
    for(const f of NEW){db.exec(sql(f));db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(f);}
    assert.equal(snapshot(db),before,"up: nothing pre-existing changed");
    assert.deepEqual({...counts()},c0);
    // 0016 adds one generation row per identity (ids and counters only); 0015 adds nothing.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM whoop_connection_generations").get().n,4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM whoop_member_request_budget").get().n,0);
    // Re-running the files (documented re-seed) still changes nothing pre-existing.
    for(const f of NEW)db.exec(sql(f));
    assert.equal(snapshot(db),before,"re-run");
    // Seat enforcement from 0002 still works after the migrations.
    db.prepare("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES(?,'supabase','x')").run(member(65));
    assert.throws(()=>db.prepare("INSERT INTO whoop_connections(user_id,expires_at,encrypted_access_token,encrypted_refresh_token,encryption_key_version,seat_role) VALUES(?,?,?,?,?,'developer')")
      .run(member(65),"2027-01-01","a","r","v1"),/UNIQUE/,"still one developer seat");
    db.prepare("DELETE FROM identity_links WHERE user_id=?").run(member(65));
    assert.equal(snapshot(db),before);
    // Rollback, reverse order.
    for(const f of [...NEW].reverse())db.exec(down(f));
    assert.equal(snapshot(db),before,"rollback: nothing pre-existing changed");
    assert.deepEqual({...counts()},c0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN (?,?)").get(...NEW_TABLES).n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM d1_migrations").get().n,0);
    // Re-apply after rollback.
    for(const f of NEW)db.exec(sql(f));
    assert.equal(snapshot(db),before,"re-apply");
    // The new tables cascade only their own rows; deleting a member is not blocked by them.
    db.prepare("INSERT INTO whoop_member_request_budget(user_id,minute_start,minute_count,day_start,day_count) VALUES(?,1,1,1,1)").run(FORMER);
    db.prepare("DELETE FROM whoop_credential_revocations WHERE user_id=?").run(FORMER);
    db.prepare("DELETE FROM whoop_members WHERE user_id=?").run(FORMER);
    // 0023 retains a fresh fence on removal; follow the former-member runbook
    // before removing its identity parent. The 0015/0016 cascades still apply.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM health_import_fences WHERE user_id=?").get(FORMER).n,1);
    db.prepare("DELETE FROM health_import_fences WHERE user_id=?").run(FORMER);
    db.prepare("DELETE FROM identity_links WHERE user_id=?").run(FORMER);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM whoop_member_request_budget").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM whoop_connection_generations WHERE user_id=?").get(FORMER).n,0);
  }finally{db.close();}
});

test("0015/0016 contain no UPDATE/DELETE/ALTER/DROP of existing objects; rollbacks drop only the new tables",()=>{
  const strip=t=>t.replace(/--.*$/gm,"");
  for(const f of NEW){
    const up=strip(sql(f));
    assert.doesNotMatch(up,/\b(ALTER|DROP)\b/i,f);
    assert.doesNotMatch(up,/\bDELETE\s+FROM\b/i,f);
    assert.doesNotMatch(up,/\bUPDATE\s+(?!SET)\w+/i,f+": no UPDATE statement (ON CONFLICT DO UPDATE SET is on the new table)");
    for(const m of up.matchAll(/\bINSERT\s+INTO\s+(\w+)/gi))assert.ok(NEW_TABLES.includes(m[1]),f+" inserts only into new tables");
    const rb=strip(down(f));
    for(const m of rb.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi))assert.ok(NEW_TABLES.includes(m[1]));
    for(const m of rb.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi))assert.equal(m[1],"d1_migrations");
    assert.doesNotMatch(rb,/\b(ALTER|UPDATE|INSERT)\b/i);
  }
});
