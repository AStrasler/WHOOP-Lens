-- Sanitized diagnostics and member issue reports (private D1 queue).
-- Only fixed codes, categories, subsystems, timestamps, request ids and an
-- internal member id. Never health values, chat text, tokens, secrets or
-- headers. Code that predates this migration never reads or writes the tables;
-- code from this branch treats a missing table as "capture off".
-- Rollback: migration/rollback/0017_member_diagnostics.down.sql (never in migrations/)
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id INTEGER PRIMARY KEY,
  -- user_key is the member id, or '' when no member is known (for example an
  -- unauthenticated request). Not a foreign key so '' is allowed.
  user_key TEXT NOT NULL CHECK(user_key='' OR length(user_key)=36),
  category TEXT NOT NULL CHECK(category IN ('whoop_api','auth','rate_limit','health_connect','ai_summary','mcp_validation','mcp_tool','infrastructure','authorization','consent','setup')),
  subsystem TEXT NOT NULL CHECK(length(subsystem) BETWEEN 1 AND 40 AND subsystem NOT GLOB '*[^a-z0-9_]*'),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^a-z0-9_]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','fail','partial')),
  retryable INTEGER NOT NULL CHECK(retryable IN (0,1)),
  -- Ten-minute window start (epoch ms). Repeats in one window bump count.
  bucket INTEGER NOT NULL CHECK(bucket>=0),
  count INTEGER NOT NULL DEFAULT 1 CHECK(count>=1),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 8 AND 40 AND request_id NOT GLOB '*[^a-z0-9_]*'),
  UNIQUE(user_key,subsystem,code,outcome,bucket)
);
CREATE INDEX IF NOT EXISTS diagnostic_events_member ON diagnostic_events(user_key,last_at DESC);
CREATE INDEX IF NOT EXISTS diagnostic_events_age ON diagnostic_events(last_at);
CREATE TABLE IF NOT EXISTS issue_reports (
  reference TEXT PRIMARY KEY CHECK(reference GLOB 'WL-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'),
  user_id TEXT NOT NULL REFERENCES identity_links(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('temporary','missing_consent','incomplete_setup','unavailable_data','backend_failure','other')),
  severity TEXT NOT NULL CHECK(severity IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','acknowledged','resolved','recurring')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500),
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key)=64 AND dedupe_key NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 8 AND 40 AND request_id NOT GLOB '*[^a-z0-9_]*'),
  -- Sanitized evidence: recent diagnostic codes for this member only.
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(evidence_json)<=4000),
  subsystems TEXT NOT NULL DEFAULT '' CHECK(length(subsystems)<=200),
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK(occurrences>=1),
  -- Rate limiting counts every submission, duplicates included, per UTC day.
  -- Owner status changes never touch these.
  day_key TEXT NOT NULL CHECK(day_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  day_submissions INTEGER NOT NULL DEFAULT 1 CHECK(day_submissions>=1),
  last_submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS issue_reports_member ON issue_reports(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_status ON issue_reports(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_day ON issue_reports(day_key);
