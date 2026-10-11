-- Explicit owner-approved linkage. No existing identity or membership is changed.
CREATE TABLE IF NOT EXISTS access_identity_links (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  approved_at TEXT NOT NULL,
  PRIMARY KEY(issuer,subject),
  UNIQUE(issuer,user_id)
);
