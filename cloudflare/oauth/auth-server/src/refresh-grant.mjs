// Refresh tokens are an authorization-server capability. The resource challenge
// cannot advertise offline_access: the pinned provider strips that scope before
// publishing protected-resource metadata. ChatGPT therefore authorizes with
// mcp:read only and rejects the connector when the token response has no
// refresh_token ("Authentication succeeded, action discovery failed").
//
// connectorRefresh is set only when the authorization request never included
// offline_access, so the member was not shown the stay-connected checkbox.
// A request that included it, and a member who left it unchecked, still gets
// no refresh token.
export function refreshGrantResult({grantType,scope,props}={}){
  const offered=Array.isArray(scope)&&scope.includes('offline_access');
  const unoffered=props?.connectorRefresh===true;
  if(offered||unoffered)return;
  if(grantType==='refresh_token')return {reject:true};
  return {refreshTokenTTL:0};
}
