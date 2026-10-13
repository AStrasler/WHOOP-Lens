-- Account-wide Workers AI neuron snapshot for one UTC day.
-- Not applied to production by adding this file.
-- neurons is the analytics total. local_used is this Worker's global counter at snapshot time.
-- fetched_at is unix milliseconds. No prompts, model outputs, or health values belong here.
CREATE TABLE IF NOT EXISTS ai_account_snapshot (
  day TEXT PRIMARY KEY,
  neurons INTEGER NOT NULL,
  local_used INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
