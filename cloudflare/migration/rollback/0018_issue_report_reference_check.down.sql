-- Rollback for migrations/0018_issue_report_reference_check.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- This deliberately does NOT restore 0017's reference CHECK: its 67-byte GLOB
-- fails on D1 for every row, so copying stored reports through it would abort
-- the rollback (and the old schema accepts no inserts anyway). The fixed table
-- and every stored report stay as they are; only the migration record is
-- removed. To remove the feature's tables entirely, export open reports first
-- and use 0017_member_diagnostics.down.sql.
DELETE FROM d1_migrations WHERE name='0018_issue_report_reference_check.sql';
