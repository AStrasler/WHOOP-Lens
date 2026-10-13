-- Cached weekly digest for one account and one week.
-- Not applied to production by adding this file.
-- body is the digest returned to the caller. Raw records do not belong here.
CREATE TABLE IF NOT EXISTS ai_weekly_digest (
  scope TEXT NOT NULL,
  week_ending TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, week_ending)
);
