import { createAuthClient } from "./auth-client.mjs";
import { parseLocalImport, importSummary, MAX_FILE_BYTES } from "./web-import.mjs";

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
function locked() {
  verified = false;
  clearPreview();
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
  document.body.textContent = "Open WhoopLens directly in your browser.";
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
  setStatus("Checking your private WhoopLens access...");
  try {
    const user = await auth.signIn(email, password);
    if (attempt !== epoch) { await auth.signOut(); return; }
    const connection = await auth.status();
    if (attempt !== epoch) { await auth.signOut(); return; }
    if (connection.connected !== true) {
      await auth.signOut();
      throw new Error("This account is not connected to WhoopLens. Request an invitation or connect WHOOP through Account setup.");
    }
    verified = true;
    $("account-label").textContent = user.email;
    $("connection-label").textContent = "WHOOP connection verified · browser preview enabled";
    $("login-panel").hidden = true;
    $("workspace").hidden = false;
    setStatus("Private account verified. You can inspect a supported file locally.");
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
      setStatus("WhoopLens access is no longer active. Sign in again.", true);
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
