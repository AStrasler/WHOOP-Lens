// Local, read-only preview. Calling this does not upload or store records.
const supported = {
  Condition: {category:"condition",field:"code",date:"recordedDate"},
  MedicationStatement: {category:"medication",field:"medicationCodeableConcept",date:"effectiveDateTime"},
  AllergyIntolerance: {category:"allergy",field:"code",date:"recordedDate"}
};
const safe = x => typeof x === "string" ? x.trim().slice(0,160) : "";
export function previewFhirR4Bundle(bundle) {
  if(!bundle||bundle.resourceType!=="Bundle"||!Array.isArray(bundle.entry)||bundle.entry.length>200)
    return {error:"Expected a FHIR R4 Bundle with at most 200 entries",candidates:[],skipped:0};
  const candidates=[];let skipped=0;
  for(const item of bundle.entry){
    const resource=item?.resource,def=supported[resource?.resourceType];
    if(!def){skipped++;continue;}
    const code=resource?.[def.field];
    const title=safe(code?.text)||safe(code?.coding?.find(x=>safe(x?.display))?.display);
    if(!title){skipped++;continue;}
    const fullDate=safe(resource?.[def.date]);
    const sourceDate=/^\d{4}-\d{2}-\d{2}/.test(fullDate)?fullDate.slice(0,10):null;
    candidates.push({
      approved:false,category:def.category,source_type:"provider_document",
      source_label:"FHIR R4 import (review required)",source_date:sourceDate,
      detail_json:{title}
    });
  }
  return {candidates,skipped,requires_review:true};
}
