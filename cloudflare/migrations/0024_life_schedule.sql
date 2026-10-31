-- Explicit per-member preference only. No backfill or inferred writes.
CREATE TABLE IF NOT EXISTS member_life_schedule (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id) ON DELETE CASCADE,
  life_schedule TEXT NOT NULL CHECK(life_schedule IN ('fixed','flexible','unpredictable')),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
