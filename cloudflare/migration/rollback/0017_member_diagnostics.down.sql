-- Rollback for migrations/0017_member_diagnostics.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Order: first set ISSUE_REPORTS_ENABLED and DIAGNOSTICS_CAPTURE_ENABLED to
-- anything but "true" (or deploy code without them), then run this. The tables
-- hold only sanitized codes and member-approved report text; no health data or
-- credentials. Dropping them loses open reports, so export them first if needed.
DROP TABLE IF EXISTS issue_reports;
DROP TABLE IF EXISTS diagnostic_events;
DELETE FROM d1_migrations WHERE name='0017_member_diagnostics.sql';
