import assert from "node:assert/strict";
import test from "node:test";
import { runE2E } from "../scripts/e2e-private-beta.mjs";

test("e2e script requires two sessions and an https base", async () => {
  await assert.rejects(runE2E({ base: "http://x", tokenA: "a", tokenB: "b", log() {} }), /https/);
  await assert.rejects(runE2E({ base: "https://x", tokenA: "a", log() {} }), /required/);
});

test("e2e script is read-only by default and never prints tokens", async () => {
  const methods = [], lines = [];
  const fetcher = async (url, init) => {
    methods.push(init.method + " " + url + " " + (init.body ?? ""));
    if (!init.headers.authorization) return new Response("{}", { status: 401 });
    if (url.endsWith("/status")) return Response.json({ connected: true });
    if (url.endsWith("/medical-context") && init.method === "GET") return Response.json({ entries: [] });
    if (init.method === "POST" && url.endsWith("/medical-context")) return Response.json({ error: "User approval required" }, { status: 400 });
    const body = JSON.parse(init.body);
    if (body.method === "tools/list") return Response.json({ result: { tools: ["get_capabilities","get_medical_context","get_health_connect","get_samsung_health"].map(name => ({ name })) } });
    return Response.json({ result: {} });
  };
  const r = await runE2E({ base: "https://x.test/functions/v1", tokenA: "secret-a", tokenB: "secret-b", fetcher, log: l => lines.push(l) });
  assert.equal(r.failed, 0);
  assert.ok(!methods.some(m => /DELETE|"approved":true/.test(m)), "no approved writes without WL_ALLOW_WRITES");
  assert.ok(!lines.join("\n").includes("secret-"));
});
