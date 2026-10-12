#!/usr/bin/env node
// Build PR 5 (Issue #7): end-to-end private-beta verification against a DEPLOYED
// WHOOP Lens Supabase project. Needs two real, approved beta sessions, so it is
// run by the owner after an approved deploy, never by CI.
//
//   WL_BASE=https://<project>.supabase.co/functions/v1 \
//   WL_TOKEN_A=<access token, user A> WL_TOKEN_B=<access token, user B> \
//   node scripts/e2e-private-beta.mjs            # read-only checks
//   WL_ALLOW_WRITES=1 node scripts/e2e-private-beta.mjs   # also create+delete one synthetic medical entry for A
//
// Tokens are read only from the environment and are never printed.
export const EXPECTED_TOOLS = ["get_capabilities", "get_medical_context", "get_health_connect", "get_samsung_health"];

export async function runE2E({ base, tokenA, tokenB, allowWrites = false, fetcher = globalThis.fetch, log = console.log }) {
  if (!base || !/^https:\/\//.test(base)) throw new Error("WL_BASE must be an https Functions URL");
  if (!tokenA || !tokenB) throw new Error("WL_TOKEN_A and WL_TOKEN_B are required (two approved beta accounts)");
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); log((ok ? "PASS " : "FAIL ") + name + (detail ? " · " + detail : "")); };
  const call = async (path, { token, method = "GET", body } = {}) => {
    const res = await fetcher(base + path, {
      method, redirect: "manual",
      headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json", accept: "application/json, text/event-stream" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  };
  const mcp = (token, id, method, params = {}) => call("/whoop-mcp/mcp", { token, method: "POST", body: { jsonrpc: "2.0", id, method, params } });
  const toolText = r => JSON.stringify(r.json?.result ?? r.json ?? {});

  check("unauthenticated MCP is refused", (await mcp(null, 1, "ping")).status === 401);
  for (const [label, token] of [["A", tokenA], ["B", tokenB]]) {
    const status = await call("/whoop-mcp/status", { token });
    check(`user ${label} is an approved, connected member`, status.status === 200 && status.json?.connected === true, "HTTP " + status.status);
    const listed = await mcp(token, 2, "tools/list");
    const names = (listed.json?.result?.tools ?? []).map(t => t.name);
    check(`user ${label} sees the expected read-only tools`, EXPECTED_TOOLS.every(n => names.includes(n)), names.join(","));
    check(`user ${label} capability directory works`, (await mcp(token, 3, "tools/call", { name: "get_capabilities", arguments: {} })).status === 200);
  }
  const listA = await call("/medical-context", { token: tokenA });
  const listB = await call("/medical-context", { token: tokenB });
  const idsA = new Set((listA.json?.entries ?? []).map(e => e.id));
  const overlap = (listB.json?.entries ?? []).some(e => idsA.has(e.id));
  check("medical context lists are owner-scoped", listA.status === 200 && listB.status === 200 && !overlap);
  check("medical context refuses unapproved writes", (await call("/medical-context", { token: tokenA, method: "POST", body: { category: "note" } })).status === 400);

  if (allowWrites) {
    const marker = "WHOOP Lens e2e synthetic " + Date.now();
    const saved = await call("/medical-context", { token: tokenA, method: "POST", body: { approved: true, category: "note", source_type: "self_reported", source_label: "e2e", detail_json: { title: marker } } });
    check("A can save a reviewed synthetic entry", saved.status === 200 && !!saved.json?.id);
    const seenByB = toolText(await mcp(tokenB, 4, "tools/call", { name: "get_medical_context", arguments: {} })).includes(marker);
    check("B's ChatGPT tool cannot read A's entry", !seenByB);
    const seenByA = toolText(await mcp(tokenA, 5, "tools/call", { name: "get_medical_context", arguments: {} })).includes(marker);
    check("A's ChatGPT tool reads A's entry", seenByA);
    if (saved.json?.id) {
      const crossDelete = await call("/medical-context?id=" + saved.json.id, { token: tokenB, method: "DELETE", body: { approved: true } });
      check("B cannot delete A's entry", crossDelete.status === 404);
      const del = await call("/medical-context?id=" + saved.json.id, { token: tokenA, method: "DELETE", body: { approved: true } });
      check("A deletes the synthetic entry (cleanup)", del.status === 200);
    }
  } else log("SKIP write checks (set WL_ALLOW_WRITES=1 to create and delete one synthetic entry)");
  const failed = results.filter(r => !r.ok).length;
  log(`${results.length - failed}/${results.length} checks passed`);
  return { results, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2E({ base: process.env.WL_BASE, tokenA: process.env.WL_TOKEN_A, tokenB: process.env.WL_TOKEN_B, allowWrites: process.env.WL_ALLOW_WRITES === "1" })
    .then(r => { process.exitCode = r.failed ? 1 : 0; })
    .catch(e => { console.error(e.message); process.exitCode = 2; });
}
