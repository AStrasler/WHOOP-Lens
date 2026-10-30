-- Proposed consent/revocation fence. Apply only in an approved release.
-- A nonce survives withdrawal even when no import/consent record exists yet.
CREATE TABLE IF NOT EXISTS health_import_fences (
 user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
 generation TEXT NOT NULL
);
