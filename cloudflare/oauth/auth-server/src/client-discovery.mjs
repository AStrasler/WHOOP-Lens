// Prefer server-side registration for new clients: refreshes of registered
// clients do not depend on a third-party metadata URL being available.
// Retain CIMD processing for existing grants; disabling it in the provider
// would immediately strand those connections.
export async function registeredClientDiscovery(request, response){
  const url=new URL(request.url);
  if(!['GET','HEAD'].includes(request.method)||
     url.origin!=='https://auth.whooplens.tech'||
     url.pathname!=='/.well-known/oauth-authorization-server'||
     response.status!==200||request.method==='HEAD')return response;
  const metadata=await response.json();
  metadata.client_id_metadata_document_supported=false;
  const headers=new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control','no-store');
  return Response.json(metadata,{status:response.status,headers});
}
