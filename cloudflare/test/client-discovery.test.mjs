import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredClientDiscovery} from '../oauth/auth-server/src/client-discovery.mjs';

test('discovery prefers registration while retaining issuer, PKCE and endpoints',async()=>{
  const metadata={issuer:'https://auth.whooplens.tech',client_id_metadata_document_supported:true,
    registration_endpoint:'https://auth.whooplens.tech/oauth/register',
    authorization_response_iss_parameter_supported:true,code_challenge_methods_supported:['S256']};
  const result=await registeredClientDiscovery(new Request('https://auth.whooplens.tech/.well-known/oauth-authorization-server'),Response.json(metadata));
  assert.deepEqual(await result.json(),{...metadata,client_id_metadata_document_supported:false});
  assert.equal(result.headers.get('cache-control'),'no-store');
});

test('discovery does not rewrite token errors or other endpoints',async()=>{
  for(const [path,status] of [['/oauth/token',400],['/.well-known/oauth-authorization-server',503]]){
    const original=Response.json({error:'invalid_client'},{status});
    assert.equal(await registeredClientDiscovery(new Request('https://auth.whooplens.tech'+path),original),original);
  }
});
