-- Disable the companion protocol and release compatible code before rollback.
DROP TABLE IF EXISTS companion_sync_status;
