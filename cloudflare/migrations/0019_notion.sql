-- Optional, per-member Notion OAuth. No global workspace token or database.
CREATE TABLE IF NOT EXISTS notion_accounts (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  generation TEXT NOT NULL,
  credentials TEXT,
  workspace_id TEXT,
  refresh_lock TEXT,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,
  config TEXT CHECK(config IS NULL OR json_valid(config)),
  config_revision TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notion_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES notion_accounts(user_id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  browser_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notion_states_owner ON notion_oauth_states(user_id);
CREATE TABLE IF NOT EXISTS notion_update_previews (
  user_id TEXT PRIMARY KEY REFERENCES notion_accounts(user_id) ON DELETE CASCADE,
  preview_hash TEXT NOT NULL,
  generation TEXT NOT NULL,
  encrypted_body TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
