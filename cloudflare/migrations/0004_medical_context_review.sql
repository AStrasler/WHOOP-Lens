-- Preserve review evidence; existing rows remain unreviewed and unreadable.
ALTER TABLE medical_context ADD COLUMN reviewed_at TEXT;
ALTER TABLE medical_context ADD COLUMN updated_at TEXT;
CREATE INDEX medical_context_reviewed_owner ON medical_context(user_id,created_at DESC,id DESC) WHERE reviewed_at IS NOT NULL;
