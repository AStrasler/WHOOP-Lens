-- Local WHOOP disconnect marker. Not applied to production until an approved deploy.
-- An in-flight callback whose state was created at or before revoked_at must not
-- store credentials after disconnect.
CREATE TABLE IF NOT EXISTS whoop_credential_revocations (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  revoked_at TEXT NOT NULL
);
