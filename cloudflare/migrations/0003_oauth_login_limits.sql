-- No IP addresses, email addresses or passwords are stored. HMAC IDs rotate
-- with AUTH_RATE_HMAC_KEY. Bucket is a coarse 15-minute UTC window.
CREATE TABLE IF NOT EXISTS oauth_login_attempts (
  bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=64),
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL CHECK(hits BETWEEN 1 AND 5),
  PRIMARY KEY(bucket_hash,window_start)
);
-- Time-based pruning can run in a later scheduled job.
CREATE INDEX IF NOT EXISTS oauth_login_window ON oauth_login_attempts(window_start);
