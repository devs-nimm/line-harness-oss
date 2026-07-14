-- 051: Conversation sessions with archive (MIN-267)
--
-- Explicit conversation-session concept shared by three archive triggers:
-- "/new" from the LINE user (MIN-267), 30-min idle TTL (MIN-265), and admin
-- delete (MIN-266). Each friend has at most one ACTIVE session
-- (archived_at IS NULL — enforced by the partial unique index); archiving
-- closes it and the next incoming message opens a new one.
--
-- Messages are associated to sessions by TIMESTAMP RANGE (created_at against
-- the archived_at boundaries), not by a session_id column on messages_log:
-- every existing write path (broadcast / scenario / manual / forms) keeps
-- working unchanged and legacy rows need no backfill. The logic lives in
-- apps/worker/src/services/chat-sessions.ts.
--
-- Archiving a session also clears the friend's ai_chat_sessions row so the
-- next message can never reuse the old previous_response_id.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id TEXT,
  started_at      TEXT NOT NULL,
  archived_at     TEXT,
  archive_reason  TEXT CHECK (archive_reason IN ('admin_delete', 'idle_ttl', 'user_new')),
  created_at      TEXT NOT NULL
);

-- At most one active session per friend; concurrent webhook deliveries race
-- on the lazy insert, the partial unique index + ON CONFLICT DO NOTHING in
-- the service make the insert atomic (same pattern as chats lazy-create).
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_active
  ON chat_sessions (friend_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_friend ON chat_sessions (friend_id, started_at);
