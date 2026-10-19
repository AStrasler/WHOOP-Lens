-- Cloudflare D1 caps LIKE/GLOB patterns at 50 bytes. 0017's reference CHECK used
-- a 67-byte GLOB, so every issue_reports INSERT failed in D1 with "LIKE or GLOB
-- pattern too complex" (local SQLite allows 50,000 bytes, so tests passed).
-- Rebuild issue_reports with an equivalent CHECK whose GLOB is 11 bytes:
-- WL- followed by exactly 8 characters from A-Z or 0-9. Rows are copied
-- unchanged (the production table is empty); nothing else is touched.
CREATE TABLE issue_reports_0018 (
  reference TEXT PRIMARY KEY CHECK(length(reference)=11 AND substr(reference,1,3)='WL-' AND substr(reference,4) NOT GLOB '*[^A-Z0-9]*'),
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
INSERT INTO issue_reports_0018(reference,user_id,category,severity,status,description,dedupe_key,request_id,evidence_json,subsystems,occurrences,day_key,day_submissions,last_submitted_at,created_at,updated_at) SELECT reference,user_id,category,severity,status,description,dedupe_key,request_id,evidence_json,subsystems,occurrences,day_key,day_submissions,last_submitted_at,created_at,updated_at FROM issue_reports;
DROP TABLE issue_reports;
ALTER TABLE issue_reports_0018 RENAME TO issue_reports;
CREATE INDEX IF NOT EXISTS issue_reports_member ON issue_reports(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_status ON issue_reports(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS issue_reports_day ON issue_reports(day_key);
