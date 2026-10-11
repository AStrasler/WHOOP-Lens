import test from 'node:test';
import assert from 'node:assert/strict';
import {auditTransferManifest,requireSafeTransferManifest} from '../migration/preflight.mjs';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const person=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const copy=x=>structuredClone(x);
function fixture(){
  return {
    authIdentities:[A,B],
    identityLinks:[
      {user_id:A,identity_provider:'supabase',provider_subject:A},
      {user_id:B,identity_provider:'supabase',provider_subject:B}
    ],
    members:[{user_id:A,active:true},{user_id:B,active:true}],
    connections:[{user_id:A,seat_role:'developer'},{user_id:B,seat_role:'public'}],
    recoveryOwners:[A,A,B],
    sleepOwners:[A,B]
  };
}
const finding=(r,code)=>r.findings.find(x=>x.code===code)?.count??0;

test('complete two-member transfer manifest passes without exposing account IDs',()=>{
  const original=fixture();const result=requireSafeTransferManifest(original);
  assert.equal(result.passed,true);
  assert.deepEqual(result.counts,{
    authIdentities:2,identityLinks:2,activeMembers:2,connectedAccounts:2,
    publicSeats:1,developerSeats:1,recoveryRecords:3,sleepRecords:2
  });
  assert.deepEqual(result.findings,[]);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(A+'|'+B,'i'));
});
test('a connected account with no member row BLOCKS migration (current source discrepancy)',()=>{
  const m=fixture();m.members.pop();
  const r=auditTransferManifest(m);
  assert.equal(r.passed,false);
  assert.equal(finding(r,'CONNECTION_MISSING_ACTIVE_MEMBERSHIP'),1);
  assert.equal(finding(r,'HEALTH_RECORD_OWNER_NOT_APPROVED'),2);
  assert.throws(()=>requireSafeTransferManifest(m),/blocked/);
});
test('inactive member and unauthorized health owner fail closed',()=>{
  const m=fixture();m.members[1].active=false;m.recoveryOwners.push(C);
  const r=auditTransferManifest(m);
  assert.equal(finding(r,'CONNECTION_MISSING_ACTIVE_MEMBERSHIP'),1);
  assert.equal(finding(r,'HEALTH_RECORD_OWNER_NOT_APPROVED'),3);
  assert.equal(r.passed,false);
  assert.doesNotMatch(JSON.stringify(r),new RegExp(C,'i'));
});
test('missing Supabase identity or mapping blocks connections',()=>{
  const m=fixture();m.authIdentities.pop();
  assert.equal(finding(auditTransferManifest(m),'CONNECTION_MISSING_AUTH_OR_LINK'),1);
  const another=fixture();another.identityLinks.pop();
  const result=auditTransferManifest(another);
  assert.equal(finding(result,'ACTIVE_MEMBER_MISSING_AUTH_OR_LINK'),1);
  assert.equal(finding(result,'CONNECTION_MISSING_AUTH_OR_LINK'),1);
});
test('wrong subject and duplicate mapping cannot silently merge two users',()=>{
  const m=fixture();m.identityLinks[1].provider_subject=A;
  assert.equal(finding(auditTransferManifest(m),'IDENTITY_LINK_SUBJECT_MISMATCH'),1);
  assert.equal(finding(auditTransferManifest(m),'DUPLICATE_IDENTITY_SUBJECT'),1);
  const other=fixture();other.connections.push({...other.connections[1]});
  assert.equal(finding(auditTransferManifest(other),'DUPLICATE_CONNECTION'),1);
});
test('public seats max 9 and developer seats max 1 are enforced',()=>{
  const m={authIdentities:[],identityLinks:[],members:[],connections:[],
    recoveryOwners:[],sleepOwners:[]};
  for(let i=1;i<=11;i++){
    const user=person(i);
    m.authIdentities.push(user);
    m.identityLinks.push({user_id:user,identity_provider:'supabase',provider_subject:user});
    m.members.push({user_id:user,active:true});
    m.connections.push({user_id:user,seat_role:i===1?'developer':'public'});
  }
  assert.equal(finding(auditTransferManifest(m),'SEAT_LIMIT_EXCEEDED'),1);
  m.connections.pop();
  assert.equal(requireSafeTransferManifest(m).passed,true);
  m.connections[1].seat_role='developer';
  assert.equal(finding(auditTransferManifest(m),'SEAT_LIMIT_EXCEEDED'),1);
});
test('unknown identifiers, unsafe extra fields and missing arrays are rejected',()=>{
  const extra=fixture();extra.connections[0].encrypted_refresh_token='SENSITIVE';
  assert.throws(()=>auditTransferManifest(extra),/Invalid migration preflight input/);
  const invalid=fixture();invalid.authIdentities.push('not-a-uuid');
  assert.throws(()=>auditTransferManifest(invalid),/Invalid migration preflight input/);
  const incomplete=fixture();delete incomplete.identityLinks;
  assert.throws(()=>auditTransferManifest(incomplete),/Invalid migration preflight input/);
});
test('the validator is pure and never alters the supplied transfer manifest',()=>{
  const m=fixture(),original=copy(m);
  auditTransferManifest(m);
  assert.deepEqual(m,original);
});
