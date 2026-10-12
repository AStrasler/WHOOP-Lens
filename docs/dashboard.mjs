import { createAuthClient } from "./auth-client.mjs";
import { parseLocalImport, importSummary, MAX_FILE_BYTES } from "./web-import.mjs";
import { buildMedicalEntry, draftFromFhirCandidate, describeEntry } from "./medical-context-ui.mjs";

const auth = createAuthClient();
const $ = id => document.getElementById(id);
let epoch = 0;
let verified = false;
let preview = null;

function setStatus(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function clearPreview() {
  preview = null;
  $("health-file").value = "";
  $("preview-panel").hidden = true;
  $("preview-meta").textContent = "";
  $("summary").replaceChildren();
  $("records").replaceChildren();
}
let editingId = null;
function medicalState(text, error = false) {
  $("medical-state").textContent = text;
  $("medical-state").classList.toggle("error", error);
}
function resetMedicalForm() {
  editingId = null;
  $("medical-form").reset();
  $("medical-form-title").textContent = "Add an entry";
  $("mc-cancel").hidden = true;
}
function fillMedicalForm(d) {
  $("mc-category").value = d.category ?? "";
  $("mc-title").value = d.title ?? "";
  $("mc-description").value = d.description ?? "";
  $("mc-source-type").value = d.source_type ?? "self_reported";
  $("mc-source-label").value = d.source_label ?? "";
  $("mc-source-date").value = d.source_date ?? "";
  $("mc-reviewed").checked = false;
}
function renderMedical(entries) {
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const box = document.createElement("div");
    box.className = "record";
    const { title, meta } = describeEntry(entry);
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = meta;
    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "secondary"; edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editingId = entry.id;
      fillMedicalForm({ ...entry, title: entry.detail_json?.title, description: entry.detail_json?.description });
      $("medical-form-title").textContent = "Edit entry";
      $("mc-cancel").hidden = false;
      $("mc-title").focus();
    });
    const del = document.createElement("button");
    del.type = "button"; del.className = "secondary"; del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!window.confirm("Delete this entry from your private WHOOP Lens account?")) return;
      try { await auth.deleteMedicalContext(entry.id); await loadMedical(); medicalState("Entry deleted."); }
      catch (error) { medicalState(error.message || "Delete failed.", true); }
    });
    actions.append(edit, del);
    box.append(strong, span, actions);
    fragment.appendChild(box);
  }
  $("medical-entries").replaceChildren(fragment);
}
async function loadMedical() {
  if (!verified) return;
  const attempt = epoch;
  medicalState("Loading your saved entries...");
  try {
    const data = await auth.listMedicalContext();
    if (attempt !== epoch || !verified) return;
    const entries = Array.isArray(data.entries) ? data.entries : [];
    renderMedical(entries);
    medicalState(entries.length ? entries.length + " saved entr" + (entries.length === 1 ? "y" : "ies") + "." : "No saved entries yet.");
  } catch (error) {
    if (attempt !== epoch) return;
    $("medical-entries").replaceChildren();
    medicalState(/not ready/i.test(error.message || "") ? "Medical context is not enabled on the server yet." : (error.message || "Unable to load medical context."), true);
  }
}
function locked() {
  verified = false;
  clearPreview();
  resetMedicalForm();
  $("medical-entries").replaceChildren();
  medicalState("Medical context loads after sign-in.");
  $("workspace").hidden = true;
  $("login-panel").hidden = false;
  $("login-button").disabled = false;
  $("password").value = "";
}
async function signOut() {
  ++epoch;
  locked();
  setStatus("Signed out. Your local preview was cleared.");
  try { await auth.signOut(); }
  catch { /* Local session is still cleared by auth-client's finally block. */ }
}
function renderPreview(result, fileName) {
  preview = result;
  $("preview-panel").hidden = false;
  $("preview-title").textContent = result.kind === "fhir_preview"
    ? "FHIR medical context · review only"
    : "Health Connect measurements · review only";
  $("preview-meta").textContent = fileName + " · " + result.records.length +
    " supported records" + (result.skipped ? " · " + result.skipped + " skipped" : "") +
    " · no information sent to the server";
  const countFragment = document.createDocumentFragment();
  for (const item of importSummary(result)) {
    const badge = document.createElement("span");
    badge.textContent = item.kind.replaceAll("_", " ") + ": " + item.count;
    countFragment.appendChild(badge);
  }
  if (!result.records.length) {
    const badge = document.createElement("span");
    badge.textContent = "No supported records found in this file.";
    countFragment.appendChild(badge);
  }
  $("summary").replaceChildren(countFragment);

  const fragment = document.createDocumentFragment();
  for (const row of result.records.slice(0, 12)) {
    const box = document.createElement("div");
    box.className = "record";
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    if (result.kind === "fhir_preview") {
      title.textContent = row.type + ": " + row.name;
      meta.textContent = "Source: FHIR R4 · " + row.date + " · not an automated medical decision";
      const use = document.createElement("button");
      use.type = "button"; use.className = "secondary"; use.textContent = "Copy to medical context form";
      use.addEventListener("click", () => {
        resetMedicalForm();
        fillMedicalForm(draftFromFhirCandidate(row));
        medicalState("Draft copied. Review it, tick the confirmation box, then save. Nothing is saved yet.");
        $("mc-title").focus();
      });
      box.append(title, meta, use);
      fragment.appendChild(box);
      continue;
    } else {
      title.textContent = row.metric.replaceAll("_", " ");
      const value = Object.entries(row.payload).map(([key, val]) => key + ": " + val).join(" · ");
      meta.textContent = (row.local_date || row.observed_at) + " · " +
        value + " " + row.unit + " · source: " + (row.origin_package || "unknown/mixed");
    }
    box.append(title, meta);
    fragment.appendChild(box);
  }
  $("records").replaceChildren(fragment);
}

if (window.top !== window.self) {
  document.body.textContent = "Open WHOOP Lens directly in your browser.";
  throw new Error("Embedded frames are not permitted.");
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const attempt = ++epoch;
  const email = $("email").value.trim();
  const password = $("password").value;
  $("password").value = "";
  $("login-button").disabled = true;
  clearPreview();
  setStatus("Checking your private WHOOP Lens access...");
  try {
    const user = await auth.signIn(email, password);
    if (attempt !== epoch) { await auth.signOut(); return; }
    const connection = await auth.status();
    if (attempt !== epoch) { await auth.signOut(); return; }
    if (connection.connected !== true) {
      await auth.signOut();
      throw new Error("This account is not connected to WHOOP Lens. Request an invitation or connect WHOOP through Account setup.");
    }
    verified = true;
    $("account-label").textContent = user.email;
    $("connection-label").textContent = "WHOOP connection verified · browser preview enabled";
    $("login-panel").hidden = true;
    $("workspace").hidden = false;
    setStatus("Private account verified. You can inspect a supported file locally.");
    void loadMedical();
  } catch (error) {
    if (attempt !== epoch) return;
    // Even a successful password exchange is not authorization to enter.
    // If the WHOOP entitlement check fails, clear the memory-only token.
    try { await auth.signOut(); } catch { /* locally cleared by finally */ }
    locked();
    setStatus(error.message || "Unable to verify your account.", true);
  } finally {
    if (attempt === epoch) $("login-button").disabled = false;
  }
});

$("logout").addEventListener("click", () => { void signOut(); });
$("clear-preview").addEventListener("click", () => {
  clearPreview();
  setStatus("Preview cleared from the page.");
});
$("health-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  const attempt = epoch;
  clearPreview();
  if (!file) return;
  if (!verified) {
    setStatus("Sign in with an authorized account first.", true);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setStatus("File too large. Choose a JSON export no larger than 500 KB.", true);
    return;
  }
  setStatus("Verifying access and reviewing your selected file locally...");
  try {
    const status = await auth.status();
    if (attempt !== epoch || !verified) return;
    if (status.connected !== true) {
      await signOut();
      setStatus("WHOOP Lens access is no longer active. Sign in again.", true);
      return;
    }
    const raw = await file.text();
    if (attempt !== epoch || !verified) return;
    // Never persist the original bytes or include them in an API request.
    const result = parseLocalImport(raw);
    renderPreview(result, file.name);
    setStatus("Local preview ready. Cloud synchronization is not enabled.");
  } catch (error) {
    if (attempt !== epoch) return;
    const message = error.message || "Unable to preview this file.";
    if (/sign-in|session|expired|unauthorized|401/i.test(message)) {
      await signOut();
      setStatus("Your session expired or is unauthorized. Sign in again.", true);
    } else {
      clearPreview();
      setStatus(message, true);
    }
  }
});

$("medical-refresh").addEventListener("click", () => { void loadMedical(); });
$("mc-cancel").addEventListener("click", () => resetMedicalForm());
$("medical-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!verified) { medicalState("Sign in with an authorized account first.", true); return; }
  let entry;
  try {
    entry = buildMedicalEntry({
      reviewed: $("mc-reviewed").checked, category: $("mc-category").value, source_type: $("mc-source-type").value,
      title: $("mc-title").value, description: $("mc-description").value,
      source_label: $("mc-source-label").value, source_date: $("mc-source-date").value,
    });
  } catch (error) { medicalState(error.message, true); return; }
  $("mc-save").disabled = true;
  try {
    if (editingId) await auth.updateMedicalContext(editingId, entry);
    else await auth.saveMedicalContext(entry);
    resetMedicalForm();
    await loadMedical();
    medicalState("Saved to your private account.");
  } catch (error) {
    medicalState(error.message || "Save failed.", true);
  } finally { $("mc-save").disabled = false; }
});
