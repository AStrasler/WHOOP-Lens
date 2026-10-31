-- A membership boundary invalidates admitted Health Connect work permanently,
-- even if an owner immediately reactivates or recreates the same member.
CREATE TRIGGER IF NOT EXISTS health_connect_member_deactivated
AFTER UPDATE OF active ON whoop_members
WHEN OLD.active=1 AND NEW.active=0
BEGIN
  INSERT INTO health_import_fences(user_id,generation)
    VALUES(OLD.user_id,lower(hex(randomblob(16))))
    ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation;
  UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP
    WHERE user_id=OLD.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS health_connect_member_removed
AFTER DELETE ON whoop_members
BEGIN
  INSERT INTO health_import_fences(user_id,generation)
    VALUES(OLD.user_id,lower(hex(randomblob(16))))
    ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation;
  UPDATE health_connect_ingest_tokens SET revoked_at=CURRENT_TIMESTAMP
    WHERE user_id=OLD.user_id AND revoked_at IS NULL;
END;
