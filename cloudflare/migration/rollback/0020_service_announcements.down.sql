-- Rollback for migrations/0020_service_announcements.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Turn ANNOUNCEMENTS_ENABLED off (or deploy code that does not read these
-- tables) before running this. Dropping the tables removes service notices
-- and audience targets. It does not delete members or health data.
DROP TABLE IF EXISTS service_announcement_targets;
DROP TABLE IF EXISTS service_announcements;
DELETE FROM d1_migrations WHERE name='0020_service_announcements.sql';
