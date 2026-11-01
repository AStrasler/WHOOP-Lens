-- WHOOP connect browser binding (WHOOP_CONNECT_BROWSER_BINDING=true).
-- Nullable and additive: existing pending states keep working while the flag is
-- off. With the flag on, a callback is accepted only from the browser that
-- confirmed the /api/whoop/start page (SHA-256 of its __Host- cookie nonce).
-- Apply this migration before enabling the flag.
ALTER TABLE whoop_oauth_states ADD COLUMN browser_hash TEXT;
