-- Conversation sessions with archive (MIN-267).
-- Mirrors packages/db/migrations/051_chat_sessions.sql (D1). Fresh installs
-- also get the table via the regenerated 0001_init.sql, so every statement
-- here is idempotent (the FK uses PostgreSQL's default constraint name,
-- which is what 0001_init's generated ALTER produces too).

CREATE TABLE IF NOT EXISTS chat_sessions (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL,
  line_account_id TEXT,
  started_at      TEXT NOT NULL,
  archived_at     TEXT,
  archive_reason  TEXT CHECK (archive_reason IN ('admin_delete', 'idle_ttl', 'user_new')),
  created_at      TEXT NOT NULL
);

DO $$ BEGIN
  ALTER TABLE chat_sessions
    ADD CONSTRAINT chat_sessions_friend_id_fkey
    FOREIGN KEY (friend_id) REFERENCES friends (id) ON DELETE CASCADE DEFERRABLE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active
  ON chat_sessions (friend_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_friend ON chat_sessions (friend_id, started_at);
