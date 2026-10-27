// Health Connect webhook delivery classification: supported-only,
// unsupported-only and mixed batches. Synthetic records only.
import assert from "node:assert/strict";
import test from "node:test";
import { mapWebhookPayload } from "../src/health-connect-webhook.mjs";
import { webhookEvent } from "../src/router.mjs";

const U="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const env={timestamp:"2026-01-02T00:00:00Z",app_version:"t1"};
const steps=[{count:10,start_time:"2026-01-01T00:00:00Z",end_time:"2026-01-01T01:00:00Z",metadata:{id:"syn-1"}}];
const unsupported={heart_rate_variability:[{rmssd:1,time:"2026-01-01T00:00:00Z"}],resting_heart_rate:[{bpm:1,time:"2026-01-01T00:00:00Z"}]};
const classify=async body=>{
  const mapped=await mapWebhookPayload(body);
  return {mapped,event:webhookEvent(200,{userId:U,result:{stored:mapped.rows.length,skipped:mapped.skipped,rejected:mapped.rejected}})};
};
test("supported-only delivery is stored and classified as success",async()=>{
  const {mapped,event}=await classify({...env,steps});
  assert.equal(mapped.rows.length,1);assert.equal(mapped.skipped,0);
  assert.deepEqual([event.code,event.outcome],["hc_delivery_stored","success"]);
});
test("unsupported-only delivery stores nothing, is not an error, and names only the skipped categories",async()=>{
  const {mapped,event}=await classify({...env,...unsupported});
  assert.equal(mapped.rows.length,0);assert.equal(mapped.rejected,0);assert.equal(mapped.skipped,2);
  assert.deepEqual(mapped.skipped_types,{heart_rate_variability:1,resting_heart_rate:1});
  // Accepted with HTTP 200 (so the sender does not retry), labelled partial
  // because nothing was stored; never retryable, never a failure.
  assert.deepEqual([event.code,event.outcome,event.retryable],["hc_only_unsupported_types","partial",false]);
});
test("mixed delivery stores the supported records and counts as stored",async()=>{
  const {mapped,event}=await classify({...env,steps,...unsupported});
  assert.equal(mapped.rows.length,1);assert.equal(mapped.skipped,2);assert.equal(mapped.rejected,0);
  assert.equal(mapped.rows[0].metric,"steps_daily");
  assert.deepEqual([event.code,event.outcome],["hc_delivery_stored","success"]);
});
test("an empty unsupported array is an empty delivery, not an unsupported one",async()=>{
  const {event}=await classify({...env,resting_heart_rate:[]});
  assert.equal(event.code,"hc_empty_delivery");
});
