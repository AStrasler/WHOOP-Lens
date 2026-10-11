-- Public seat reservations must be protected by the DATABASE, not a racy read-check-write.
-- Existing WHOOP Lens sandbox limit: at most 9 public + 1 developer.
CREATE TRIGGER IF NOT EXISTS limit_public_whoop_seats_insert
BEFORE INSERT ON whoop_connections
WHEN NEW.seat_role='public' AND
  (SELECT COUNT(*) FROM whoop_connections WHERE seat_role='public')>=9
BEGIN
  SELECT RAISE(ABORT,'Public WHOOP seats are full');
END;
CREATE TRIGGER IF NOT EXISTS limit_public_whoop_seats_role_change
BEFORE UPDATE OF seat_role ON whoop_connections
WHEN NEW.seat_role='public' AND OLD.seat_role<>'public' AND
  (SELECT COUNT(*) FROM whoop_connections WHERE seat_role='public')>=9
BEGIN
  SELECT RAISE(ABORT,'Public WHOOP seats are full');
END;
-- The initial migration already enforces one developer with a partial UNIQUE index.
