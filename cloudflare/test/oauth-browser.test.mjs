import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {probeConsentRedirects} from './fixtures/oauth-browser-probe.mjs';
const chrome=process.env.WHOOP_TEST_CHROME ||
  (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'');
// An explicitly available browser is required; no downloads or real OAuth traffic.
test('Chrome consent redirect chain: Android repaired, ChatGPT preserved, foreign host blocked',
  {skip:!chrome||!existsSync(chrome),timeout:20000},async t=>{
    const results=await probeConsentRedirects(chrome);
    for(const result of results) await t.test(result.name,()=>{
      assert.equal(result.passed,true);
      if(result.name==='before Android')assert.equal(result.resubmissionRejected,true);
    });
  });
