-- Rollback for migrations/0015_member_whoop_request_budget.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Order: first deploy code that does not use the table (or set
-- WHOOP_MEMBER_LIMIT_ENABLED="false"), then run this. The table only holds
-- request counters (no health data, no credentials); dropping it loses nothing
-- but the current minute/day counts. Code from this branch treats a missing
-- table as "limit not enforced" and logs it, so it keeps serving if run early.
DROP TABLE IF EXISTS whoop_member_request_budget;
DELETE FROM d1_migrations WHERE name='0015_member_whoop_request_budget.sql';
