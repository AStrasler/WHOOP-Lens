-- Private opt-in journal. No existing medical context is copied or consent inferred.
CREATE TABLE IF NOT EXISTS flare_consent (
 user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
 storage INTEGER NOT NULL CHECK(storage IN (0,1)),
 analysis INTEGER NOT NULL CHECK(analysis IN (0,1) AND analysis<=storage),
 generation TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS flare_journal (
 user_id TEXT NOT NULL REFERENCES identity_links(user_id),
 entry_key TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body) AND length(body)<=12000),
 revision TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,entry_key)
);
