-- Rollback for migrations/0018_issue_report_reference_check.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Restores 0017's definition, whose 67-byte GLOB makes every report INSERT fail
-- on D1. Only use this to return to the exact 0017 schema; set
-- ISSUE_REPORTS_ENABLED to anything but "true" first.
CREATE TABLE issue_reports_0017 (
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
INSERT INTO issue_reports_0017(reference,user_id,category,severity,status,description,dedupe_key,request_id,evidence_json,subsystems,occurrences,day_key,day_submissions,last_submitted_at,created_at,updated_at) SELECT reference,user_id,category,severity,status,description,dedupe_key,request_id,evidence_json,subsystems,occurrences,day_key,day_submissions,last_submitted_at,created_at,updated_at FROM issue_reports;
DROP TABLE issue_reports;
ALTER TABLE issue_reports_0017 RENAME TO issue_reports;
CREATE INDEX IF NOT EXISTS issue_reports_member ON issue_reports(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_status ON issue_reports(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_day ON issue_reports(day_key);
DELETE FROM d1_migrations WHERE name='0018_issue_report_reference_check.sql';
