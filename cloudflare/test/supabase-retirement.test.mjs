import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('live Cloudflare resource and capability catalog do not depend on Supabase',()=>{
  for(const file of ['../oauth/resource/src/index.mjs','../src/extra-tools.mjs','../src/capabilities.json']){
    const source=read(file);
    assert.doesNotMatch(source,/supabase\.co|SUPABASE_PUBLIC_KEY|supabase\/functions|verifySupabaseSession/i, file);
  }
});
