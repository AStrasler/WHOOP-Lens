// Cloudflare adds this header to accepted 0-RTT requests. A supplied header
// exercises this guard; it is not evidence that a TLS early-data flight occurred.
export function rejectEarlyData(request){
 if(['GET','HEAD','OPTIONS'].includes(request.method)&&request.headers.get('Early-Data')==='1')
  return new Response('Retry after the TLS handshake',{status:425,headers:{'cache-control':'no-store'}});
 return null;
}
