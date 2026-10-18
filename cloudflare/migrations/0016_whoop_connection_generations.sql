-- WHOOP connection generation per member. Bumped in the same D1 batch as every
-- OAuth callback that stores credentials (including a reconnect that overwrites
-- an existing connection without a disconnect) and every disconnect. History
-- cursors carry the generation they were issued under and are rejected once it
-- changes. A missing row is generation 0, which is also what cursors issued
-- before this migration are treated as, so existing sequences keep working
-- until the member's next reconnect or disconnect.
-- Code that predates this migration never reads or writes the table.
-- Rollback: migration/rollback/0016_whoop_connection_generations.down.sql (never in migrations/)
CREATE TABLE IF NOT EXISTS whoop_connection_generations (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
