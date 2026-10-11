import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {verifyUpstreamCode,upstreamAuthorizationUrl,CALLBACK_URI} from '../oauth/auth-server/src/upstream.mjs';
const issuer='https://synthetic.cloudflareaccess.com',aud='a'.repeat(64),now=1800000000000;
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'synthetic',alg:'RS256',use:'sig'};
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
async function token(change={},head={}){
 const input=enc({alg:'RS256',kid:'synthetic',...head})+'.'+enc({iss:issuer,aud:[aud],sub:'subject-a',email:'synthetic@example.invalid',type:'app',iat:now/1000-10,exp:now/1000+300,...change});
 return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(input))).toString('base64url');
}
function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const path of ['0001_initial.sql','0005_access_identity_links.sql'])db.exec(readFileSync(new URL('../migrations/'+path,import.meta.url),'utf8'));
 db.exec("INSERT INTO identity_links(user_id,identity_provider,provider_subject) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cloudflare_access','subject-a'); INSERT INTO whoop_members(user_id,active) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1);");
 db.prepare('INSERT INTO access_identity_links VALUES(?,?,?,1,?)').run(issuer,'subject-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-11');
 const env={ACCESS_ISSUER:issuer,ACCESS_AUD:aud,DB:{prepare(sql){let args=[];return {bind(...a){args=a;return this;},async first(){return db.prepare(sql).get(...args)??null;}};}}};
 const seen=[];
 async function verify(jwt,overrides={}){return verifyUpstreamCode({request:new Request(CALLBACK_URI+'?code=access',{headers:{'cf-access-jwt-assertion':jwt}}),code:'access',env,now,fetcher:async url=>{seen.push(url);assert.equal(url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});},...overrides});}
 return {db,env,seen,verify};
}
test('Access signs in only an explicitly linked active member with no Supabase calls',async()=>{
 const f=fixture();try{assert.equal(await f.verify(await token()),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');assert.deepEqual(f.seen,[issuer+'/cdn-cgi/access/certs']);
 const url=new URL(await upstreamAuthorizationUrl({state:'s'.repeat(43),env:f.env}));assert.equal(url.origin,'https://auth.whooplens.tech');assert.equal(url.searchParams.get('code'),'access');
 }finally{f.db.close();}
});
test('Access rejects forged signatures and wrong claims without trusting identity headers',async()=>{
 const f=fixture();try{
 for(const change of [{iss:'https://other.cloudflareaccess.com'},{aud:['b'.repeat(64)]},{exp:now/1000},{iat:now/1000+100},{nbf:now/1000+100},{sub:''},{type:'service'},{email:undefined}])await assert.rejects(f.verify(await token(change)));
 const good=await token();const parts=good.split('.');parts[1]=enc({sub:'subject-b'});await assert.rejects(f.verify(parts.join('.')));
 await assert.rejects(f.verify(await token({}, {alg:'none'})));
 await assert.rejects(f.verify('not-a-token'));
 await assert.rejects(f.verify(good,{code:'arbitrary'}));
 await assert.rejects(f.verify(good,{request:new Request(CALLBACK_URI,{headers:{'cf-access-authenticated-user-email':'synthetic@example.invalid'}})}));
 }finally{f.db.close();}
});
test('Access never links by email and immediately respects disabled membership or mapping',async()=>{
 const f=fixture();try{await assert.rejects(f.verify(await token({sub:'subject-b'})));
 f.db.exec('UPDATE whoop_members SET active=0');await assert.rejects(f.verify(await token()));
 f.db.exec('UPDATE whoop_members SET active=1; UPDATE access_identity_links SET enabled=0');await assert.rejects(f.verify(await token()));
 }finally{f.db.close();}
});
test('Access fails closed for key outages and invalid configuration',async()=>{
 const f=fixture();try{const jwt=await token();
 for(const keys of [[],[jwk,jwk],[{...jwk,kid:'other'}]])await assert.rejects(f.verify(jwt,{fetcher:async()=>Response.json({keys})}));
 await assert.rejects(f.verify(jwt,{fetcher:async()=>new Response('',{status:503})}));
 await assert.rejects(f.verify(jwt,{env:{...f.env,ACCESS_ISSUER:'https://attacker.invalid'}}));
 }finally{f.db.close();}
});
