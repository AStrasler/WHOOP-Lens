// RB-004 / RB-006: distinct, sanitized reason codes for summary fallbacks and
// Notion errors. Synthetic inputs only.
import test from "node:test";
import assert from "node:assert/strict";
import {selectionFailure,selectedSummaryText} from "../src/ai-summary.mjs";
import {classifyToolError} from "../src/diagnostics.mjs";
import {NotionError} from "../src/notion-client.mjs";

const statements=["a.","b.","c."];
test("every rejected model selection gets a specific, fixed reason",()=>{
  for(const [raw,reason] of [
    ["x".repeat(1001),"selection_too_long"],
    ["Your recovery looks great.","selection_not_json"],
    ['{"selected":[0],"extra":1}',"selection_shape"],
    ['[0]',"selection_shape"],
    ['{"selected":[]}',"selection_count"],
    ['{"selected":[0,1,2,0]}',"selection_count"],
    ['{"selected":[1,1]}',"selection_duplicate"],
    ['{"selected":[3]}',"selection_out_of_range"],
    ['{"selected":[-1]}',"selection_out_of_range"],
    ['{"selected":[0.5]}',"selection_out_of_range"],
  ]){
    assert.equal(selectedSummaryText(raw,statements),null,raw.slice(0,30));
    assert.equal(selectionFailure(raw,statements),reason,raw.slice(0,30));
    assert.match(reason,/^[a-z_]{1,24}$/);
  }
});

test("Notion setup states are separated from real request failures",()=>{
  const cases={
    connection_required:["setup","notion_not_connected",false],
    daily_log_not_configured:["setup","notion_not_configured",false],
    disabled:["setup","notion_disabled",false],
    membership_required:["authorization","notion_membership_required",false],
    invalid_arguments:["mcp_validation","notion_invalid_request",false],
    connection_changed:["mcp_tool","notion_state_changed",true],
    service_unavailable:["mcp_tool","notion_unavailable",true],
    response_unavailable:["mcp_tool","notion_unavailable",true],
    write_outcome_unknown:["mcp_tool","notion_write_outcome_unknown",false],
  };
  for(const [code,[category,diag,retryable]] of Object.entries(cases)){
    const k=classifyToolError(new NotionError(code,409),"notion_get_daily_log");
    assert.deepEqual([k.category,k.code,k.retryable],[category,diag,retryable],code);
  }
  // Provider status mapping from notion-client statusError().
  for(const [code,status,diag] of [["authorization_required",401,"notion_auth_required"],["permission_denied",403,"notion_forbidden"],
    ["not_shared_or_missing",404,"notion_not_found"],["service_unavailable",502,"notion_unavailable"],["rate_limited",429,"notion_rate_limited"]])
    assert.equal(classifyToolError(new NotionError(code,status),"notion_get_daily_log").code,diag,code);
  // Unknown codes keep the generic code; nothing from the message leaks.
  const odd=classifyToolError(new NotionError("Bearer secret-token https://x",500),"notion_get_daily_log");
  assert.equal(odd.code,"notion_request_failed");
  assert.equal(odd.retryable,true);
  assert.equal(classifyToolError(new NotionError("__proto__",400),"notion_x").code,"notion_request_failed");
  for(const v of Object.values(cases))assert.match(v[1],/^[a-z0-9_]{1,64}$/);
});
