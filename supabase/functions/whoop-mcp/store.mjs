// Shared Supabase client helpers for the gated Health Connect and disconnect
// paths. Membership matches the rest of whoop-mcp: a missing whoop_members row
// stays active, and active = false is the kill switch.

export async function supabaseMemberActive(db, userId) {
  const { data: member, error } = await db.from("whoop_members").select("active").eq("user_id", userId).maybeSingle();
  if (error) return { error: true };
  if (member && member.active === false) return { active: false };
  return { active: true };
}

export async function requireActiveMember(db, userId) {
  const member = await supabaseMemberActive(db, userId);
  if (member.error) throw new Error("Import unavailable");
  if (!member.active) throw new Error("Not authorized");
  return userId;
}

export function storageFailed(error) {
  const code = error?.code;
  const message = String(error?.message ?? "");
  return code === "42P01" || code === "PGRST205" || code === "PGRST202" || code === "42883"
    || /does not exist|schema cache/i.test(message);
}

export async function callRpc(db, name, args) {
  if (typeof db?.rpc !== "function") {
    const missing = new Error("Import unavailable");
    missing.code = "PGRST202";
    throw missing;
  }
  const { data, error } = await db.rpc(name, args);
  if (error) {
    const wrapped = new Error("Import unavailable");
    wrapped.code = error.code;
    throw wrapped;
  }
  return data;
}
