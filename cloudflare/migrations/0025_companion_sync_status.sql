-- Successful companion imports only; consent grants/token rotations are not syncs.
CREATE TABLE IF NOT EXISTS companion_sync_status (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id) ON DELETE CASCADE,
  last_sync_at TEXT NOT NULL
);
