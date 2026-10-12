import assert from "node:assert/strict";
import test from "node:test";
import {previewFhirR4Bundle} from "./fhir-preview.mjs";

test("FHIR R4 preview maps only supported records and never approves import",()=>{
  const bundle={resourceType:"Bundle",type:"collection",entry:[
    {resource:{resourceType:"Condition",code:{text:"Synthetic condition"},recordedDate:"2026-10-01"}},
    {resource:{resourceType:"MedicationStatement",medicationCodeableConcept:{text:"Example medicine"},effectiveDateTime:"2026-10-02T01:00:00Z"}},
    {resource:{resourceType:"Patient",name:[{family:"PRIVATE"}]}}
  ]};
  const result=previewFhirR4Bundle(bundle);
  assert.equal(result.candidates.length,2);
  assert.equal(result.skipped,1);
  assert.ok(result.candidates.every(x=>x.approved===false&&x.source_type==="provider_document"));
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
  assert.equal(result.requires_review,true);
});
test("FHIR import rejects unrecognized files, too many entries, and missing labels",()=>{
  assert.ok(previewFhirR4Bundle({}).error);
  assert.ok(previewFhirR4Bundle({resourceType:"Bundle",entry:Array(201).fill({})}).error);
  assert.equal(previewFhirR4Bundle({resourceType:"Bundle",entry:[{resource:{resourceType:"Condition"}}]}).skipped,1);
});
