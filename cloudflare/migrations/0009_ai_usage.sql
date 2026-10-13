-- Daily Workers AI neuron counters only. Not applied to production by adding this file.
-- Rows are scope + UTC day. scope is "global" or "user:" plus the member id.
-- No prompts, model outputs, or health values belong in this table.
CREATE TABLE IF NOT EXISTS ai_usage (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL,
  cap INTEGER NOT NULL,
  PRIMARY KEY (scope, day)
);
