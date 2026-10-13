// Lazy and batched re-encryption of stored WHOOP tokens to the current key.
// Only runs while WHOOP_TOKEN_AES256_KEY_NEXT is set. Nothing is deleted and
// the k1 path stays until a later promotion. Logs counts and key ids only.
import {openWithKeyring,sealWithKeyring,needsReseal,tokenKeyring} from "./token-crypto.mjs";
const BATCH_INTERVAL_MS=10*60_000;
let lastBatch=0;
export function resetMigrationThrottle(){lastBatch=0;}
export async function migrateConnection(db,userId,row,keys){
  if(keys.current!=="k2")return "current";
  const access=await openWithKeyring(row.encrypted_access_token,{userId,purpose:"access",keys});
  const refresh=await openWithKeyring(row.encrypted_refresh_token,{userId,purpose:"refresh",keys});
  if(!needsReseal(row.encrypted_access_token,access.key,keys)&&
     !needsReseal(row.encrypted_refresh_token,refresh.key,keys))return "current";
  const nextAccess=await sealWithKeyring(access.token,{userId,purpose:"access",keys});
  const nextRefresh=await sealWithKeyring(refresh.token,{userId,purpose:"refresh",keys});
  // Optimistic: a concurrent refresh that already rewrote the row wins.
  const result=await db.prepare(
    "UPDATE whoop_connections SET encrypted_access_token=?1,encrypted_refresh_token=?2,"+
    "encryption_key_version='k2',updated_at=CURRENT_TIMESTAMP "+
    "WHERE user_id=?3 AND encrypted_access_token=?4 AND encrypted_refresh_token=?5"
  ).bind(nextAccess,nextRefresh,userId,row.encrypted_access_token,row.encrypted_refresh_token).run();
  return result?.success&&result.meta?.changes===1?"migrated":"raced";
}
export async function tokenKeyCounts(db){
  const row=await db.prepare(
    "SELECT COUNT(*) AS total,"+
    "SUM(CASE WHEN encrypted_access_token LIKE 'v2.k2.%' AND encrypted_refresh_token LIKE 'v2.k2.%' THEN 1 ELSE 0 END) AS on_k2 "+
    "FROM whoop_connections"
  ).first();
  const total=Number(row?.total??0),onK2=Number(row?.on_k2??0);
  return {total,on_k2:onK2,remaining:total-onK2};
}
export async function migrateAllTokens(db,env,{limit=25,now=Date.now,force=false}={}){
  let keys;
  try{keys=tokenKeyring(env);}catch{return {skipped:"no_key"};}
  if(keys.current!=="k2")return {skipped:"no_next_key"};
  if(!force&&now()-lastBatch<BATCH_INTERVAL_MS)return {skipped:"throttled"};
  lastBatch=now();
  const rows=await db.prepare(
    "SELECT user_id,encrypted_access_token,encrypted_refresh_token FROM whoop_connections "+
    "WHERE encrypted_access_token NOT LIKE 'v2.k2.%' OR encrypted_refresh_token NOT LIKE 'v2.k2.%' LIMIT ?1"
  ).bind(limit).all();
  let migrated=0,failed=0,raced=0;
  for(const row of rows?.results||[]){
    try{
      const outcome=await migrateConnection(db,row.user_id,row,keys);
      if(outcome==="migrated")migrated++;
      else if(outcome==="raced")raced++;
    }catch{failed++;}
  }
  const counts=await tokenKeyCounts(db);
  const line={event:"token_key_migration",key:"k2",migrated,raced,failed,...counts};
  console.log(JSON.stringify(line));
  return line;
}
