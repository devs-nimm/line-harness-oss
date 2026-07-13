-- 050: Per-friend AI chat sessions for the OpenAI /responses auto-reply
--
-- The auto-reply now calls the Responses API and chains conversation state
-- server-side via previous_response_id — the backend never loads message
-- history, it only stores the last response id per friend.
--   * turn_count counts user messages in the current session; once it reaches
--     the max (30, constant in openai-auto-reply.ts) the next message starts a
--     fresh session (previous_response_id omitted, counter reset).
--   * A LINE user sending exactly "/new" deletes their row (fresh session).

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  friend_id TEXT PRIMARY KEY,
  line_account_id TEXT,
  last_response_id TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
