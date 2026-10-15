// Regenerates test/fixtures/stress-estimate-sample.json: node test/make-stress-fixture.mjs
import {writeFileSync} from "node:fs";
import {computeStressEstimate} from "../src/stress-estimate.mjs";
import {syntheticUser} from "./stress-fixture-data.mjs";
const u=syntheticUser();
const targetDates=u.recoveries.slice(-10).map(r=>r.created_at.slice(0,10));
const out=computeStressEstimate({recoveryRecords:u.recoveries,sleepRecords:u.sleeps,targetDates,sleepAvailable:true});
writeFileSync(new URL("./fixtures/stress-estimate-sample.json",import.meta.url),JSON.stringify(out,null,2)+"\n");
