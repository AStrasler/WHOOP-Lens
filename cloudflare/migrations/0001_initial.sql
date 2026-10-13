-- WHOOP Lens: Cloudflare D1 schema, staged migration. SQLite, not Postgres.
-- Never expose this database to public SQL APIs. ONLY authenticated Workers may query it.
-- No live user records, OAuth codes, sessions or encrypted WHOOP tokens are copied by schema creation.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS identity_links (
  user_id TEXT PRIMARY KEY,
  identity_provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(identity_provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS whoop_members (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS whoop_connections (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  expires_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  encryption_key_version TEXT NOT NULL,
  seat_role TEXT NOT NULL CHECK(seat_role IN ('public','developer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS only_one_developer_seat ON whoop_connections(seat_role) WHERE seat_role='developer';
CREATE TABLE IF NOT EXISTS whoop_recovery (
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  whoop_id TEXT NOT NULL,
  date TEXT NOT NULL,
  score REAL,
  hrv REAL,
  resting_heart_rate REAL,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  whoop_user_id TEXT,
  PRIMARY KEY(user_id,whoop_id)
);
CREATE TABLE IF NOT EXISTS whoop_sleep (
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  whoop_id TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  performance_percentage REAL,
  efficiency_percentage REAL,
  total_sleep_seconds INTEGER,
  rem_sleep_seconds INTEGER,
  slow_wave_sleep_seconds INTEGER,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  whoop_user_id TEXT,
  PRIMARY KEY(user_id,whoop_id)
);
CREATE TABLE IF NOT EXISTS whoop_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS samsung_health_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  metric TEXT NOT NULL CHECK(length(metric) BETWEEN 2 AND 64),
  source_record_hash TEXT NOT NULL CHECK(length(source_record_hash)=64),
  observed_at TEXT,
  exported_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'samsung_health' CHECK(source='samsung_health'),
  transport TEXT NOT NULL DEFAULT 'samsung_health_data_sdk',
  sdk_record_json TEXT NOT NULL CHECK(json_valid(sdk_record_json)),
  inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,metric,source_record_hash)
);
CREATE TABLE IF NOT EXISTS whoop_waitlist (
  user_id TEXT PRIMARY KEY REFERENCES identity_links(user_id),
  contact_email TEXT,
  destination TEXT NOT NULL DEFAULT 'whoop-lens@outlook.com',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS health_connect_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  metric TEXT NOT NULL CHECK(metric IN ('steps_daily','sleep_session','heart_rate','exercise_session')),
  record_key TEXT NOT NULL,
  origin_package TEXT,
  observed_at TEXT NOT NULL,
  ended_at TEXT,
  local_date TEXT,
  unit TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,metric,record_key)
);
CREATE TABLE IF NOT EXISTS medical_context (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_links(user_id),
  source_type TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_date TEXT,
  category TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS whoop_recovery_owner_date ON whoop_recovery(user_id,date DESC);
CREATE INDEX IF NOT EXISTS whoop_sleep_owner_start ON whoop_sleep(user_id,start_time DESC);
CREATE INDEX IF NOT EXISTS samsung_records_owner_time ON samsung_health_records(user_id,inserted_at DESC);
CREATE INDEX IF NOT EXISTS hc_owner_time ON health_connect_records(user_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS med_owner_date ON medical_context(user_id,source_date DESC);
