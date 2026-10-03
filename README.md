# WHOOP Lens

Hosted ChatGPT and Codex plugin for reading a person's own WHOOP data. It can also read Samsung Health records that were uploaded for that same person. This is an independent project. It is not affiliated with WHOOP.

## How it is hosted

The consent and connection UI in `docs/` is the GitHub Pages site: [https://astrasler.github.io/WHOOP-Lens/](https://astrasler.github.io/WHOOP-Lens/). Each person signs in with their own Supabase user. This repository does not add a separate account system.

WHOOP requests are handled by the Supabase edge function `whoop-mcp`. Its source is `supabase/functions/whoop-mcp/index.ts`. Supabase processes those requests. The integration does not run only on the visitor's computer.

WHOOP access and refresh tokens are encrypted per Supabase user and stored in Supabase. They are not stored only in the browser. The Pages app keeps the Supabase sign-in session in memory for the open tab.

Runtime secrets stay in the Supabase function environment. Do not commit tokens, WHOOP credentials, or service keys.

## WHOOP access

Connecting WHOOP requests these read scopes: `read:profile`, `read:body_measurement`, `read:recovery`, `read:sleep`, `read:workout`, and `read:cycles`, plus `offline` so the function can refresh access. The plugin does not request write access to WHOOP.

## Samsung Health

`get_samsung_health` reads Samsung Health records stored for the signed-in Supabase user, including sleep, heart rate, activity, and related measurements. Those records are a separate source from WHOOP.

## Revocation

Revoke the integration in your WHOOP account settings to stop future WHOOP reads. Revocation does not delete information already returned to ChatGPT or Codex. Sign out of the Pages app to drop the in-memory Supabase session. A Supabase user can also be disabled with the optional `whoop_members` kill switch; a valid Supabase user is otherwise allowed.

See [Privacy.md](Privacy.md) for how data is handled.
