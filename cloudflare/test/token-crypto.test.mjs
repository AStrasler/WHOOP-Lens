import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealWhoopToken,openWhoopToken } from "../src/token-crypto.mjs";
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key=()=>randomBytes(32).toString("base64url");
test("new Cloudflare token envelope roundtrips without plaintext storage",async()=>{
  const secret=key(),raw="synthetic-whoop-test-token-do-not-use",opts={userId:A,purpose:"access",key:secret};
  const first=await sealWhoopToken(raw,opts),second=await sealWhoopToken(raw,opts);
  assert.notEqual(first,second,"random IV required");
  assert.equal(first.startsWith("v1."),true);
  assert.doesNotMatch(first,/synthetic-whoop/);
  assert.equal(await openWhoopToken(first,opts),raw);
});
test("ciphertext cannot cross tenant/purpose/key boundaries or survive tampering",async()=>{
  const secret=key(),opts={userId:A,purpose:"refresh",key:secret};
  const envelope=await sealWhoopToken("synthetic-refresh-token",opts);
  await assert.rejects(openWhoopToken(envelope,{...opts,userId:B}));
  await assert.rejects(openWhoopToken(envelope,{...opts,purpose:"access"}));
  await assert.rejects(openWhoopToken(envelope,{...opts,key:key()}));
  const pieces=envelope.split(".");
  const last=pieces[2].slice(0,-1)+(pieces[2].at(-1)==="A"?"B":"A");
  await assert.rejects(openWhoopToken(pieces[0]+"."+pieces[1]+"."+last,opts));
});
test("invalid user, key, version and token contents rejected",async()=>{
  const opts={userId:A,purpose:"access",key:key()};
  await assert.rejects(sealWhoopToken("",opts));
  await assert.rejects(sealWhoopToken("x",{...opts,userId:"not-a-uuid"}));
  await assert.rejects(sealWhoopToken("x",{...opts,purpose:"password"}));
  await assert.rejects(sealWhoopToken("x",{...opts,key:"short"}));
  await assert.rejects(openWhoopToken("v2.fake.fake",opts));
  await assert.rejects(openWhoopToken("v1.fake.fake",opts));
});
