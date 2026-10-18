-- WHOOP connection generation per member. Bumped in the same D1 batch as every
-- OAuth callback that stores credentials (including a reconnect that overwrites
-- an existing connection without a disconnect) and every disconnect. History
-- cursors carry the generation they were issued under and are rejected once it
-- changes; with this table present, a cursor without a generation is rejected.
-- Code that predates this migration never reads or writes the table.
-- Rollback: migration/rollback/0016_whoop_connection_generations.down.sql (never in migrations/)
CREATE TABLE IF NOT EXISTS whoop_connection_generations (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Seed every existing member with a generation above anything issued before.
-- The value is the apply time in milliseconds, so it also exceeds every
-- generation from an earlier copy of this table (dropped by the rollback and
-- applied again: bumps are +1 per reconnect, far fewer than the milliseconds
-- between two applies). Any cursor sealed before this statement, including one
-- whose member reconnected while the table was absent or while old code was
-- serving, then no longer matches. Re-running this file bumps again, which only
-- makes outstanding cursors restart. Only member ids and counters; no health data.
INSERT INTO whoop_connection_generations(user_id,generation)
  SELECT user_id,CAST(strftime('%s','now') AS INTEGER)*1000 FROM identity_links WHERE true
  ON CONFLICT(user_id) DO UPDATE SET
    generation=MAX(whoop_connection_generations.generation+1,excluded.generation),
    updated_at=CURRENT_TIMESTAMP;
