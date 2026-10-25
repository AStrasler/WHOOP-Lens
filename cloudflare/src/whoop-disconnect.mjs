// RB-017: disconnect_whoop also asks WHOOP to revoke this app's access, using
// WHOOP's documented endpoint DELETE /developer/v2/user/access
// (operationId revokeUserOAuthAccess, 204 on success). Best effort only:
// local credential deletion always proceeds, whatever WHOOP returns, and the
// member is told plainly whether access at WHOOP was revoked.
// Off unless WHOOP_PROVIDER_REVOKE_ENABLED==='true'.
import {openWithKeyring,tokenKeyring} from './token-crypto.mjs';
import {revokeWhoopConnection} from './whoop-oauth.mjs';
import {activeMembership} from './storage.mjs';

export const WHOOP_REVOKE_URL='https://api.prod.whoop.com/developer/v2/user/access';
const REVOKE_TIMEOUT_MS=5000;
export const REVOKED_MESSAGE='WhoopLens no longer has access to your WHOOP account, and your stored WHOOP credentials were deleted.';
export const MANUAL_MESSAGE='Your stored WHOOP credentials were deleted from WhoopLens. To also remove WhoopLens from your WHOOP account, remove it from the connected apps in your WHOOP account settings.';

export function providerRevokeEnabled(env){return env?.WHOOP_PROVIDER_REVOKE_ENABLED==='true';}

// Returns a sanitized reason code only; never a token, body or upstream text.
export async function revokeAtWhoop(db,userId,env,{fetcher=fetch,now=()=>Date.now()}={}){
  if(!providerRevokeEnabled(env))return {revoked:false,reason:'whoop_revoke_disabled'};
  let row;
  try{row=await db.prepare('SELECT expires_at,encrypted_access_token FROM whoop_connections WHERE user_id=?1').bind(userId).first();}
  catch{return {revoked:false,reason:'whoop_revoke_lookup_failed'};}
  if(!row?.encrypted_access_token)return {revoked:false,reason:'whoop_revoke_no_connection'};
  const expires=Date.parse(row.expires_at);
  // No refresh here: rotating tokens during a disconnect could race a read.
  if(!Number.isFinite(expires)||expires<=now())return {revoked:false,reason:'whoop_revoke_token_expired'};
  let token;
  try{token=(await openWithKeyring(row.encrypted_access_token,{userId,purpose:'access',keys:tokenKeyring(env)})).token;}
  catch{return {revoked:false,reason:'whoop_revoke_token_unavailable'};}
  let response;
  try{response=await fetcher(WHOOP_REVOKE_URL,{method:'DELETE',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(REVOKE_TIMEOUT_MS)});}
  catch{return {revoked:false,reason:'whoop_revoke_network'};}
  const s=response?.status;
  if(s===204||s===200)return {revoked:true,reason:'whoop_revoked'};
  if(s===401)return {revoked:false,reason:'whoop_revoke_unauthorized'};
  if(s===429)return {revoked:false,reason:'whoop_revoke_rate_limited'};
  if(s>=500)return {revoked:false,reason:'whoop_revoke_unavailable'};
  return {revoked:false,reason:'whoop_revoke_rejected'};
}

export async function disconnectWhoop(db,userId,env,{fetcher=fetch,now=()=>Date.now()}={}){
  // Membership is checked before any provider call; the local step re-checks.
  let provider={revoked:false,reason:'whoop_revoke_disabled'};
  if(providerRevokeEnabled(env)&&await activeMembership(db,userId).catch(()=>false)){
    try{provider=await revokeAtWhoop(db,userId,env,{fetcher,now});}
    catch{provider={revoked:false,reason:'whoop_revoke_failed'};}
  }
  const local=await revokeWhoopConnection(db,userId);
  return {...local,whoop_access_revoked:provider.revoked,whoop_revoke_reason:provider.reason,
    message:provider.revoked?REVOKED_MESSAGE:MANUAL_MESSAGE};
}
