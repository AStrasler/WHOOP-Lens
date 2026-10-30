import test from 'node:test';
import assert from 'node:assert/strict';
import './replay-harness.mjs';
const {default:AuthWorker}=await import('../../oauth/auth-server/src/index.mjs');
const {default:resource}=await import('../../oauth/resource/src/index.mjs');
test('early-data application guard: all GET/HEAD/OPTIONS route families reject before bindings or side effects',async()=>{
 const authPaths=['/authorize','/oauth/upstream/callback','/.well-known/oauth-authorization-server','/oauth/token','/oauth/register','/request-seat','/unknown'];
 const resourcePaths=['/','/privacy','/android/oauth/callback','/.well-known/assetlinks.json','/.well-known/oauth-protected-resource/mcp','/mcp','/api/whoop/callback','/v1/whoop/connect','/v1/whoop/profile','/v1/whoop/measurements','/v1/whoop/recovery','/v1/whoop/sleep','/v1/whoop/workouts','/v1/whoop/cycles','/v1/status','/v1/recovery','/v1/sleep','/v1/health-connect','/v1/health-connect/import','/v1/health-connect/status','/api/health-connect/webhook','/api/notion/start','/api/notion/callback','/v1/announcements','/v1/announcements/manage','/v1/announcements/update','/unknown'];
 // Any accidental binding lookup fails this test before a guard can mask it.
 const env=new Proxy({},{get(){throw Error('Early request touched bindings');}});
 for(const method of ['GET','HEAD','OPTIONS']){
  for(const path of authPaths){
   const response=await AuthWorker.prototype.fetch.call({env,ctx:{}},new Request('https://auth.whooplens.tech'+path,{method,headers:{'Early-Data':'1'}}));
   assert.equal(response.status,425,method+' '+path);assert.equal(response.headers.get('cache-control'),'no-store');
  }
  for(const path of resourcePaths){
   const response=await resource.fetch(new Request('https://whooplens.tech'+path,{method,headers:{'Early-Data':'1'}}),env,{});
   assert.equal(response.status,425,method+' '+path);
  }
 }
});
