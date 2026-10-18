-- Per-member WHOOP request budget (fair share of WHOOP's app-wide limits).
-- One row per member holds the current UTC minute and UTC day counters, so the
-- table never grows past one row per member. A missing row means "nothing used
-- yet": existing members start with a full budget and nobody is locked out.
-- minute_start = floor(epoch_ms / 60000), day_start = floor(epoch_ms / 86400000).
-- Code that predates this migration never reads or writes the table.
-- Rollback: migration/rollback/0015_member_whoop_request_budget.down.sql (never in migrations/)
CREATE TABLE IF NOT EXISTS whoop_member_request_budget (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id) ON DELETE CASCADE,
  minute_start INTEGER NOT NULL CHECK(minute_start>=0),
  minute_count INTEGER NOT NULL CHECK(minute_count>=0),
  day_start INTEGER NOT NULL CHECK(day_start>=0),
  day_count INTEGER NOT NULL CHECK(day_count>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
