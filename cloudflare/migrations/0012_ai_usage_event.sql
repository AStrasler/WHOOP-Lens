-- Local reservation times for one UTC day.
-- Not applied to production by adding this file.
-- amount is neurons reserved after an analytics sample. Raw records do not belong here.
CREATE TABLE IF NOT EXISTS ai_usage_event (
  day TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_event_day_at ON ai_usage_event(day, at_ms);
ALTER TABLE ai_account_snapshot ADD COLUMN recent_local INTEGER NOT NULL DEFAULT 0;
