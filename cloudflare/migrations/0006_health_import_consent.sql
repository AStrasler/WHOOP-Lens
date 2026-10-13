-- Consent for user-selected Health Connect v2 file imports.
-- Not applied to production until a separate approval. Existing rows are untouched.
CREATE TABLE IF NOT EXISTS health_import_consent (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  purpose TEXT NOT NULL CHECK(purpose='health_connect_file'),
  granted_at TEXT NOT NULL,
  withdrawn_at TEXT
);
