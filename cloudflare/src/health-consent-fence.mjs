import {ACTIVE_MEMBER_SQL} from './storage.mjs';
export const HEALTH_FENCE_SQL='EXISTS (SELECT 1 FROM health_import_fences WHERE user_id=?1 AND generation=?4)';
export const HEALTH_WRITE_SQL='EXISTS ('+ACTIVE_MEMBER_SQL+') AND '+HEALTH_FENCE_SQL;
// Capture at authenticated admission, before waiting for upload bytes.
export async function healthImportAdmission(db,userId){
 await db.prepare('INSERT INTO health_import_fences(user_id,generation) SELECT ?1,?2 WHERE EXISTS ('+ACTIVE_MEMBER_SQL+') ON CONFLICT(user_id) DO NOTHING').bind(userId,crypto.randomUUID()).run();
 const row=await db.prepare('SELECT generation FROM health_import_fences WHERE user_id=?1').bind(userId).first();
 if(!row)throw Error('Not authorized');
 return row.generation;
}
export function advanceHealthFence(db,userId){
 return db.prepare('INSERT INTO health_import_fences(user_id,generation) VALUES(?1,?2) ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation').bind(userId,crypto.randomUUID());
}
