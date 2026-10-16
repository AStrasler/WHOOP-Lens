-- Request metadata only. No membership, identity, seat or health writes.
CREATE TABLE IF NOT EXISTS seat_request_limits (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seat_request_delivery (
 email_hash TEXT PRIMARY KEY, claim TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')), expires_at INTEGER NOT NULL
);
