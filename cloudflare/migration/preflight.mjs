// WHOOP Lens zero-write migration preflight. No user identity or health values
// are included in findings; migration must never proceed on a failed audit.
// This does NOT authorize data transfer, Cloudflare deployment or DNS changes.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS={
  member:['user_id','active'],
  connection:['user_id','seat_role'],
  identityLink:['user_id','identity_provider','provider_subject']
};
function invalid(){throw Error('Invalid migration preflight input');}
function id(value){
  if(typeof value!=='string'||!UUID.test(value))invalid();
  return value.toLowerCase();
}
function records(value,kind){
  if(!Array.isArray(value)||value.length>250000)invalid();
  return value.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))invalid();
    const actual=Object.keys(row),allowed=KEYS[kind];
    if(actual.length!==allowed.length||!actual.every(k=>allowed.includes(k)))invalid();
    if(kind==='member'){
      if(typeof row.active!=='boolean')invalid();
      return {user_id:id(row.user_id),active:row.active};
    }
    if(kind==='connection'){
      if(!['public','developer'].includes(row.seat_role))invalid();
      return {user_id:id(row.user_id),seat_role:row.seat_role};
    }
    if(row.identity_provider!=='supabase')invalid();
    return {user_id:id(row.user_id),identity_provider:'supabase',
      provider_subject:id(row.provider_subject)};
  });
}
function ids(value){
  if(!Array.isArray(value)||value.length>500000)invalid();
  return value.map(id);
}
function counted(failures,code,value){
  if(value>0)failures.push({code,count:value});
}
function duplicates(values){
  return values.length-new Set(values).size;
}
export function auditTransferManifest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).length!==6||
    !['authIdentities','identityLinks','members','connections','recoveryOwners','sleepOwners']
      .every(k=>Object.prototype.hasOwnProperty.call(input,k)))invalid();
  const auth=ids(input.authIdentities);
  const links=records(input.identityLinks,'identityLink');
  const members=records(input.members,'member');
  const connections=records(input.connections,'connection');
  const recovery=ids(input.recoveryOwners),sleep=ids(input.sleepOwners);
  const authSet=new Set(auth);
  const linkIds=new Set(links.map(r=>r.user_id));
  const memberIds=new Set(members.filter(r=>r.active).map(r=>r.user_id));
  const membersById=new Map(members.map(r=>[r.user_id,r]));
  const connIds=connections.map(r=>r.user_id);
  const pub=connections.filter(r=>r.seat_role==='public').length;
  const dev=connections.filter(r=>r.seat_role==='developer').length;
  const findings=[];
  counted(findings,'DUPLICATE_AUTH_IDENTITY',duplicates(auth));
  counted(findings,'DUPLICATE_IDENTITY_LINK',duplicates(links.map(r=>r.user_id)));
  counted(findings,'DUPLICATE_IDENTITY_SUBJECT',duplicates(links.map(r=>r.provider_subject)));
  counted(findings,'DUPLICATE_MEMBERSHIP',duplicates(members.map(r=>r.user_id)));
  counted(findings,'DUPLICATE_CONNECTION',duplicates(connIds));
  counted(findings,'IDENTITY_LINK_SUBJECT_MISMATCH',
    links.filter(r=>r.user_id!==r.provider_subject).length);
  counted(findings,'IDENTITY_LINK_NOT_IN_AUTH',
    links.filter(r=>!authSet.has(r.provider_subject)).length);
  counted(findings,'ACTIVE_MEMBER_MISSING_AUTH_OR_LINK',
    members.filter(r=>r.active&&(!authSet.has(r.user_id)||!linkIds.has(r.user_id))).length);
  counted(findings,'CONNECTION_MISSING_ACTIVE_MEMBERSHIP',
    connections.filter(r=>membersById.get(r.user_id)?.active!==true).length);
  counted(findings,'CONNECTION_MISSING_AUTH_OR_LINK',
    connections.filter(r=>!authSet.has(r.user_id)||!linkIds.has(r.user_id)).length);
  counted(findings,'HEALTH_RECORD_OWNER_NOT_APPROVED',
    [...recovery,...sleep].filter(owner=>!authSet.has(owner)||
      !linkIds.has(owner)||!memberIds.has(owner)).length);
  counted(findings,'SEAT_LIMIT_EXCEEDED',Number(pub>9)+Number(dev>1));
  return {
    passed:findings.length===0,
    counts:{
      authIdentities:auth.length,identityLinks:links.length,
      activeMembers:memberIds.size,connectedAccounts:connections.length,
      publicSeats:pub,developerSeats:dev,
      recoveryRecords:recovery.length,sleepRecords:sleep.length
    },
    findings
  };
}
export function requireSafeTransferManifest(input,expectedSourceCounts){
  const report=auditTransferManifest(input);
  if(!report.passed)throw Error('Migration preflight blocked; review aggregated findings');
  // An empty/stale manifest must not look equivalent to a successful transfer.
  // Expected totals must be obtained INDEPENDENTLY from an owner-approved,
  // scope-matched, read-only source snapshot before any cutover is considered.
  const fields=Object.keys(report.counts);
  if(!expectedSourceCounts||typeof expectedSourceCounts!=='object'||
     Array.isArray(expectedSourceCounts)||
     Object.keys(expectedSourceCounts).length!==fields.length||
     !fields.every(k=>Object.hasOwn(expectedSourceCounts,k)&&
       Number.isSafeInteger(expectedSourceCounts[k])&&
       expectedSourceCounts[k]>=0))
    throw Error('Migration preflight blocked; independently verified source totals required');
  if(expectedSourceCounts.connectedAccounts<1)
    throw Error('Migration preflight blocked; nonempty approved source snapshot required');
  if(fields.some(k=>report.counts[k]!==expectedSourceCounts[k]))
    throw Error('Migration preflight blocked; source snapshot counts differ');
  // Matching totals do NOT establish provenance, authorize data transfer,
  // waive privacy review, or permit a production Cloudflare deployment.
  return report;
}
