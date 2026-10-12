// Pure helpers for the private medical-context panel. They mirror the
// medical-context Edge Function's validation so the browser never sends an
// entry the server would reject, and never sends anything without review.
export const CATEGORIES = ["condition", "medication", "allergy", "note"];
export const SOURCE_TYPES = ["self_reported", "provider_document"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildMedicalEntry(form) {
  const category = String(form.category ?? "");
  const sourceType = String(form.source_type ?? "");
  const title = String(form.title ?? "").trim();
  const description = String(form.description ?? "").trim();
  const sourceLabel = String(form.source_label ?? "").trim();
  const sourceDate = String(form.source_date ?? "").trim();
  if (form.reviewed !== true) throw new Error("Confirm that you reviewed this entry before saving.");
  if (!CATEGORIES.includes(category)) throw new Error("Choose a category.");
  if (!SOURCE_TYPES.includes(sourceType)) throw new Error("Choose where this information came from.");
  if (!title || title.length > 200) throw new Error("Add a short title (up to 200 characters).");
  if (description.length > 2000) throw new Error("Details must be 2,000 characters or fewer.");
  if (sourceLabel.length > 160) throw new Error("Source label must be 160 characters or fewer.");
  if (sourceDate && (!DATE.test(sourceDate) || !Number.isFinite(Date.parse(sourceDate)))) {
    throw new Error("Source date must be YYYY-MM-DD.");
  }
  const detail_json = { title };
  if (description) detail_json.description = description;
  return {
    category, source_type: sourceType, detail_json,
    source_label: sourceLabel || null, source_date: sourceDate || null,
  };
}

// FHIR candidates from the local preview become unsaved, provider-labelled
// drafts. The user must still review each one; nothing is saved automatically.
export function draftFromFhirCandidate(row) {
  const map = { Condition: "condition", MedicationStatement: "medication", AllergyIntolerance: "allergy" };
  return {
    category: map[row?.type] ?? "note",
    source_type: "provider_document",
    title: String(row?.name ?? "").slice(0, 200),
    description: "",
    source_label: "FHIR R4 import (review required)",
    source_date: DATE.test(String(row?.date ?? "")) ? row.date : "",
    reviewed: false,
  };
}

export function describeEntry(entry) {
  const origin = entry.source_type === "provider_document" ? "Provider document" : "Self-reported";
  const parts = [entry.category, origin];
  if (entry.source_label) parts.push(entry.source_label);
  if (entry.source_date) parts.push(entry.source_date);
  return { title: String(entry.detail_json?.title ?? "(untitled)"), meta: parts.join(" · ") };
}
