-- Proposed only; do not apply until the OAuth cutover is owner-approved.
-- Existing KV state is intentionally not imported or silently consulted.
-- Retain tombstones: deleting them would reopen stale-write resurrection.
CREATE TABLE IF NOT EXISTS oauth_security_state (
 key TEXT PRIMARY KEY,
 value TEXT,
 revision INTEGER NOT NULL CHECK(revision > 0),
 expires_at INTEGER,
 metadata_json TEXT,
 grant_key TEXT
);
CREATE INDEX IF NOT EXISTS oauth_security_state_grant ON oauth_security_state(grant_key);
