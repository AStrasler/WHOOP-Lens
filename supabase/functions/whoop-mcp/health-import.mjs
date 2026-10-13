// Web file import for Health Connect v2 JSON. Not a phone sync.
// Ownership comes only from the verified caller. Writes go through one RPC so
// consent and rows commit together, matching the Cloudflare D1 batch.
import { parseLocalImport } from "./web-import.mjs";
import { callRpc, requireActiveMember } from "./store.mjs";

export const IMPORT_CONSENT = "store-health-connect-file";
export const WITHDRAW_CONSENT = "delete-my-health-connect-records";
const SAFE = /^(Consent required|Choose a JSON file|This file is not valid JSON|Expected a |Invalid measurement|Invalid exercise|Invalid originating|Only a Health Connect|An end time|One of the local|Duplicate |Unsupported unit|A date is missing)/;

export function publicImportError(error) {
  const message = error instanceof Error ? error.message : "";
  return SAFE.test(message) ? message : null;
}

export async function importHealthConnectFile(db, userId, file, consent, { now = Date.now() } = {}) {
  await requireActiveMember(db, userId);
  if (consent !== IMPORT_CONSENT) throw new Error("Consent required");
  const text = typeof file === "string" ? file : JSON.stringify(file);
  const parsed = parseLocalImport(text, now);
  if (parsed.kind !== "health_connect_preview") {
    throw new Error("Only a Health Connect v2 file can be stored. FHIR bundles stay a local preview.");
  }
  const granted = new Date(now).toISOString();
  const rows = parsed.records.map((row) => ({ id: crypto.randomUUID(), ...row }));
  const data = await callRpc(db, "import_health_connect_records", {
    p_user_id: userId,
    p_granted_at: granted,
    p_rows: rows,
  });
  if (data?.stored !== rows.length) throw new Error("Import unavailable");
  return { stored: rows.length, source: "health_connect", transport: "web_file_import", consent: "granted" };
}

export async function withdrawHealthConnectImport(db, userId, consent) {
  await requireActiveMember(db, userId);
  if (consent !== WITHDRAW_CONSENT) throw new Error("Consent required");
  const data = await callRpc(db, "withdraw_health_connect_import", { p_user_id: userId });
  return {
    deleted: data?.deleted ?? 0,
    consent: "withdrawn",
    source: "health_connect",
    ingest_tokens_revoked: data?.ingest_tokens_revoked ?? 0,
  };
}
