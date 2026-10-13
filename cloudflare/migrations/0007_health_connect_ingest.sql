-- Per-user Health Connect webhook tokens. Only a SHA-256 hex digest is stored.
-- Not applied to production until a separate approval. Existing rows are untouched.
CREATE TABLE IF NOT EXISTS health_connect_ingest_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  window_started_at TEXT,
  window_hits INTEGER NOT NULL DEFAULT 0 CHECK(window_hits>=0)
);
CREATE INDEX IF NOT EXISTS health_connect_ingest_owner ON health_connect_ingest_tokens(user_id);
-- One usable token per member. Revoked rows stay so the old digest cannot be reissued by guessing.
CREATE UNIQUE INDEX IF NOT EXISTS health_connect_ingest_one_active
  ON health_connect_ingest_tokens(user_id) WHERE revoked_at IS NULL;
