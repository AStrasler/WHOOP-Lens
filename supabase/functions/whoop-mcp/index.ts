import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createWhoopMcp } from "./handler.mjs";

// Runtime secrets come from the Supabase function environment. Do not hardcode them.
// verify_jwt stays false: this function checks the Supabase user and WHOOP OAuth itself,
// and the WHOOP callback has no gateway JWT. See supabase/config.toml.
const url = Deno.env.get("SUPABASE_URL")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const encKey = Deno.env.get("WHOOP_TOKEN_ENCRYPTION_KEY")!;
const db = createClient(url, service);

Deno.serve(createWhoopMcp({
  db,
  encKey,
  env: (name) => Deno.env.get(name),
  log: (entry) => console.log(JSON.stringify(entry)),
}));
