// Strict, dependency-free LOCAL file preview. No networking, tokens, or persistence.
import { previewFhirR4Bundle } from "./fhir-preview.mjs";

export const WEB_HEALTH_UPLOADS_ENABLED = false;
export const MAX_FILE_BYTES = 512_000;
const metrics = {
  steps_daily: { unit: "steps", fields: ["count"] },
  sleep_session: { unit: "seconds", fields: ["duration_seconds"] },
  heart_rate: { unit: "bpm", fields: ["bpm"] },
  exercise_session: { unit: "seconds", fields: ["duration_seconds", "exercise_type"] }
};
const idPattern = /^[-\w:.+]{1,128}$/;
const packagePattern = /^[a-zA-Z0-9_.]+$/;

function timestamp(value, now) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      Math.abs(Date.parse(value) - now) >= 366 * 86_400_000) {
    throw new Error("A date is missing, invalid, or outside the one-year import window.");
  }
  return new Date(value).toISOString();
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) {
    throw new Error("One of the local calendar dates is invalid.");
  }
  return value;
}

export function parseLocalImport(text, now = Date.now()) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES)
    throw new Error("Choose a JSON file no larger than 500 KB.");
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("This file is not valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Expected a health-data JSON object.");

  // FHIR R4 intake is a PREVIEW only; diagnoses/medication context is never
  // passed to the Health Connect measurements endpoint.
  if (data.resourceType === "Bundle") {
    const result = previewFhirR4Bundle(data);
    if (result.error) throw new Error(result.error);
    return {
      kind: "fhir_preview", source: "FHIR R4 Bundle",
      records: result.candidates.map(x => ({
        type: x.category, date: x.source_date || "date unspecified",
        name: x.detail_json.title
      })),
      skipped: result.skipped,
      canUpload: false
    };
  }

  if (data.schema_version !== 2 || data.source !== "health_connect" ||
      !Array.isArray(data.records) || data.records.length > 100) {
    throw new Error("Expected a WhoopLens Health Connect v2 JSON export (up to 100 records), or a FHIR R4 Bundle.");
  }
  timestamp(data.exported_at, now);
  const seen = new Set();
  const records = data.records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        !Object.hasOwn(metrics, record.metric) ||
        typeof record.record_key !== "string" || !idPattern.test(record.record_key)) {
      throw new Error("Invalid measurement or record key at row " + (index + 1) + ".");
    }
    const key = record.metric + ":" + record.record_key;
    if (seen.has(key)) throw new Error("Duplicate measurement key in this file.");
    seen.add(key);
    const spec = metrics[record.metric];
    const observed_at = timestamp(record.observed_at, now);
    const ended_at = record.ended_at == null ? null : timestamp(record.ended_at, now);
    if (ended_at && Date.parse(ended_at) < Date.parse(observed_at))
      throw new Error("An end time is earlier than a start time.");
    const local_date = record.local_date == null ? null : validDate(record.local_date);
    const origin_package = record.origin_package == null ? null : record.origin_package;
    if (origin_package != null &&
        (typeof origin_package !== "string" || origin_package.length > 160 ||
          !packagePattern.test(origin_package))) {
      throw new Error("Invalid originating application label.");
    }
    if (record.unit !== spec.unit || !record.payload ||
        typeof record.payload !== "object" || Array.isArray(record.payload) ||
        Object.keys(record.payload).length !== spec.fields.length ||
        spec.fields.some(field => !Object.hasOwn(record.payload, field))) {
      throw new Error("Unsupported unit or data fields at row " + (index + 1) + ".");
    }
    const payload = {};
    for (const field of spec.fields) {
      const value = record.payload[field];
      if (field === "exercise_type") {
        if (typeof value !== "string" || value.length < 1 || value.length > 80)
          throw new Error("Invalid exercise type.");
      } else if (typeof value !== "number" || !Number.isFinite(value) ||
        value < 0 || value > 10_000_000 ||
        ((field === "count" || field === "bpm") && !Number.isInteger(value))) {
        throw new Error("Invalid measurement value at row " + (index + 1) + ".");
      }
      payload[field] = value;
    }
    return {
      metric: record.metric, record_key: record.record_key, observed_at, ended_at,
      local_date, origin_package, unit: spec.unit, payload
    };
  });
  return {
    kind: "health_connect_preview", source: "WhoopLens Health Connect v2 JSON",
    records, exported_at: data.exported_at, canUpload: false
  };
}

export function importSummary(result) {
  const totals = Object.create(null);
  for (const row of result.records) {
    const kind = row.metric || row.type;
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return Object.entries(totals).map(([kind, count]) => ({kind, count}));
}
