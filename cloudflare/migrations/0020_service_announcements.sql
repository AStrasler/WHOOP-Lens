-- Owner-managed service announcements (maintenance, outage, restoration, update).
-- D1 only. Supabase is retired and is not used. Nothing here stores health
-- data, names, or emails. Audience targets store the existing pseudonymous
-- member id and are removed with that member; the notice itself is service-wide.
-- The table is unused until ANNOUNCEMENTS_ENABLED is exactly "true".
-- Rollback: migration/rollback/0020_service_announcements.down.sql (never in migrations/)
CREATE TABLE IF NOT EXISTS service_announcements (
  id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('maintenance','outage','restoration','update')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  audience TEXT NOT NULL CHECK(audience IN ('all','members')),
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','scheduled','active','expired','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS service_announcements_visibility ON service_announcements(status, starts_at);
CREATE TABLE IF NOT EXISTS service_announcement_targets (
  announcement_id TEXT NOT NULL CHECK(length(announcement_id)=32 AND announcement_id NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES identity_links(user_id) ON DELETE CASCADE CHECK(length(user_id)=36),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS service_announcement_targets_member ON service_announcement_targets(user_id);
