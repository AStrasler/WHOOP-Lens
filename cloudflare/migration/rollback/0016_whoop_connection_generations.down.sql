-- Rollback for migrations/0016_whoop_connection_generations.sql.
-- Kept outside migrations/ so `wrangler d1 migrations apply` never runs it.
-- Dropping the table is safe for every code version: code from this branch
-- detects the missing table, skips only the generation check (disconnect-based
-- cursor rejection from whoop_credential_revocations still applies) and keeps
-- the OAuth callback and disconnect working. Cursors issued while the table
-- existed keep working after the drop (pre-migration behaviour). Applying 0016
-- again seeds every member above all earlier generations, so those cursors,
-- and any issued while the table was absent, are rejected once it is back.
-- No health data or credentials are stored here.
DROP TABLE IF EXISTS whoop_connection_generations;
DELETE FROM d1_migrations WHERE name='0016_whoop_connection_generations.sql';
