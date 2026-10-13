// Secret resolution with a Secrets Store backup.
// The Worker secret stays primary. A BK_<NAME> secrets_store_secrets binding is
// read only when the primary is missing or fails its format check. A decrypt
// failure never triggers the backup: only the stored format is checked here.
// Logs name, source and reason only. Never a value.
const B64URL32=/^[A-Za-z0-9_-]{43}$/;
function decodesTo32(value){
  if(typeof value!=="string"||!B64URL32.test(value))return false;
  try{
    const raw=atob(value.replaceAll("-","+").replaceAll("_","/")+"=");
    return raw.length===32;
  }catch{return false;}
}
const noSpace=v=>typeof v==="string"&&v.length>0&&!/\s/.test(v);
export const SECRET_RULES=Object.freeze({
  WHOOP_CLIENT_ID:v=>noSpace(v)&&v.length>=8&&v.length<=256,
  WHOOP_CLIENT_SECRET:v=>noSpace(v)&&v.length>=16&&v.length<=512,
  WHOOP_TOKEN_AES256_KEY:decodesTo32,
  WHOOP_TOKEN_AES256_KEY_NEXT:decodesTo32,
  AI_ACCOUNT_ANALYTICS_TOKEN:v=>noSpace(v)&&v.length>=20&&v.length<=4096
});
export const BACKUP_PREFIX="BK_";
// Each distinct outcome is logged once per isolate, not on every request.
const logged=new Set();
export function resetSecretLog(){logged.clear();}
function log(line){
  const key=JSON.stringify(line);
  if(logged.has(key))return;
  logged.add(key);
  console.log(JSON.stringify({event:"secret_source",...line}));
}
export async function getSecret(env,name){
  const valid=SECRET_RULES[name];
  if(!valid)throw Error("Unknown secret");
  const primary=env?.[name];
  if(valid(primary))return primary;
  const reason=primary==null||primary===""?"missing":"invalid";
  const binding=env?.[BACKUP_PREFIX+name];
  if(!binding||typeof binding.get!=="function"){
    // NEXT is optional, so its absence is normal and not logged.
    if(name!=="WHOOP_TOKEN_AES256_KEY_NEXT"||reason!=="missing")log({secret:name,source:"none",reason});
    return null;
  }
  let backup=null;
  try{backup=await binding.get();}catch{backup=null;}
  if(valid(backup)){
    log({secret:name,source:"store",reason});
    return backup;
  }
  log({secret:name,source:"none",reason,store:"invalid"});
  return null;
}
// Returns env with a known secret replaced only when the primary fails its check
// and the store backup passes. Otherwise the primary is left exactly as it was,
// so existing error handling is unchanged. Other bindings are untouched.
export async function resolveSecrets(env){
  if(!env||typeof env!=="object")return env;
  const out={...env};
  for(const name of Object.keys(SECRET_RULES)){
    const value=await getSecret(env,name);
    if(value!=null)out[name]=value;
  }
  return out;
}
