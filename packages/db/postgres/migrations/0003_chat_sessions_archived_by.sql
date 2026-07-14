-- Audit trail for admin-triggered archives (MIN-266).
-- Mirrors packages/db/migrations/052_chat_sessions_archived_by.sql (D1).
-- Fresh installs also get the column via the regenerated 0001_init.sql,
-- so the statement is idempotent.

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_by TEXT;
