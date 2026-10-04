const linkedEmailPattern = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function linkedAccount(value) {
  if (typeof value !== "string" || value.length > 254 || !linkedEmailPattern.test(value)) return "";
  return value;
}

export function landingNote(params) {
  if (params.get("disabled") === "1") {
    return { text: "This account is disabled.", error: true };
  }
  if (params.get("seat") === "developer_unavailable") {
    return { text: "The developer seat is already assigned, so WHOOP was not connected.", error: true };
  }
  if (params.get("waitlist") === "1") {
    return {
      text: "Public WHOOP seats are full, so WHOOP was not connected. This account can be listed for a notice at whoop-lens@outlook.com when a seat opens.",
      error: false,
    };
  }
  if (params.get("connected") === "1") {
    const linked = linkedAccount(params.get("linked_email"));
    return {
      text: linked
        ? "WHOOP is linked to the Supabase user " + linked + ". Sign in with that account to confirm the connection."
        : "Returned from WHOOP. Sign in to check that your account is connected.",
      error: false,
    };
  }
  return null;
}
