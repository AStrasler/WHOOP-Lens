import test from 'node:test';
import assert from 'node:assert/strict';
import {readBounded} from '../src/bounded-body.mjs';
import {createStagingRouter} from '../src/router.mjs';
test('byte limits cancel chunked bodies and reject invalid UTF-8; valid bodies survive',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(100));},cancel(){cancelled=true;}});
  assert.deepEqual(await readBounded(new Request('https://test.invalid',{method:'POST',body,duplex:'half'}),50),{error:'too_large'});
  assert.equal(cancelled,true);
  assert.deepEqual(await readBounded(new Response(new Uint8Array([255])),20),{error:'invalid'});
  assert.deepEqual(await readBounded(new Response('éé'),3),{error:'too_large'});
  assert.deepEqual(await readBounded(new Response('{}'),2),{text:'{}'});
});
test('MCP rejects oversized streams before decoding or dispatch',async()=>{
  let calls=0,cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(300000));},cancel(){cancelled=true;}});
  const response=await createStagingRouter({verifyIdentity:async()=>{calls++;throw Error('unreachable');}})(
    new Request('https://whooplens.tech/mcp',{method:'POST',duplex:'half',body,headers:{'content-type':'application/json',accept:'application/json,text/event-stream'}}),
    {MIGRATION_API_ENABLED:'true',MCP_ENABLED:'true',WHOOP_READS_ENABLED:'true',DB:{}});
  assert.equal(response.status,413);assert.equal(calls,0);assert.equal(cancelled,true);
});
