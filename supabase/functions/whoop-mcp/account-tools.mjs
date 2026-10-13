// Account-write tools ported from the Cloudflare WHOOP Lens worker.
// They are listed and executed only when the matching env flag is exactly "true".
import { ISSUE_CONSENT, REVOKE_CONFIRM } from "./health-connect-webhook.mjs";

const IMPORT_CONSENT = "store-health-connect-file";
const WITHDRAW_CONFIRM = "delete-my-health-connect-records";
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destroy = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const accountTools = [
  {
    name: "disconnect_whoop",
    description: "Delete only this account’s stored WHOOP credentials on WHOOP Lens. The WHOOP account itself is unchanged.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: destroy,
  },
  {
    name: "import_health_connect_file",
    description: "Store a user-selected WHOOP Lens Health Connect v2 JSON file for the signed-in account. This is a file import, not a live Health Connect sync.",
    inputSchema: {
      type: "object",
      properties: {
        consent: { type: "string", enum: [IMPORT_CONSENT] },
        file_json: { type: "string", minLength: 2, maxLength: 12000 },
      },
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "withdraw_health_connect_import",
    description: "Delete stored Health Connect records for the signed-in account, record consent withdrawal, and revoke phone ingest tokens.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", enum: [WITHDRAW_CONFIRM] },
      },
      additionalProperties: false,
    },
    annotations: destroy,
  },
  {
    name: "issue_health_connect_ingest_token",
    description: "Issue this account’s Health Connect webhook token. Replaces any current token, grants storage consent, and shows the secret once.",
    inputSchema: {
      type: "object",
      properties: {
        consent: { type: "string", enum: [ISSUE_CONSENT] },
      },
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "revoke_health_connect_ingest_token",
    description: "Revoke this account’s Health Connect webhook tokens. Stored records remain until withdrawal.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", enum: [REVOKE_CONFIRM] },
      },
      additionalProperties: false,
    },
    annotations: destroy,
  },
];

const byName = new Map(accountTools.map((tool) => [tool.name, tool]));

export function accountToolEnabled(name, flagOn) {
  if (name === "disconnect_whoop") return flagOn("WHOOP_DISCONNECT_ENABLED");
  if (name === "import_health_connect_file") return flagOn("WEB_HEALTH_IMPORT_ENABLED");
  if (name === "withdraw_health_connect_import") {
    return flagOn("WEB_HEALTH_IMPORT_ENABLED") || flagOn("HEALTH_CONNECT_WEBHOOK_ENABLED");
  }
  if (name === "issue_health_connect_ingest_token" || name === "revoke_health_connect_ingest_token") {
    return flagOn("HEALTH_CONNECT_WEBHOOK_ENABLED");
  }
  return false;
}

export function accountArguments(name, args) {
  const tool = byName.get(name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const schema = tool.inputSchema.properties;
  if (Object.keys(args).some((key) => !Object.hasOwn(schema, key))) return null;
  for (const [key, value] of Object.entries(args)) {
    const rule = schema[key];
    if (rule.enum && !rule.enum.includes(value)) return null;
    if (rule.type === "string" && typeof value !== "string") return null;
  }
  if (name === "disconnect_whoop") return {};
  if (name === "withdraw_health_connect_import") {
    return args.confirm === WITHDRAW_CONFIRM ? { confirm: args.confirm } : null;
  }
  if (name === "issue_health_connect_ingest_token") {
    return args.consent === ISSUE_CONSENT ? { consent: args.consent } : null;
  }
  if (name === "revoke_health_connect_ingest_token") {
    return args.confirm === REVOKE_CONFIRM ? { confirm: args.confirm } : null;
  }
  if (name === "import_health_connect_file") {
    if (args.consent !== IMPORT_CONSENT || typeof args.file_json !== "string"
      || args.file_json.length < 2 || args.file_json.length > 12000) return null;
    return { consent: args.consent, file_json: args.file_json };
  }
  return null;
}
