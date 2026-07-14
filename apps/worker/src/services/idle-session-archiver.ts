// 30-min idle TTL for conversation sessions (MIN-265).
//
// Runs on the 5-minute cron: any active chat_sessions row whose friend has
// had no message (incoming or outgoing, non-test) for IDLE_TTL_MINUTES is
// archived with reason 'idle_ttl' via the shared archive function (which
// also clears ai_chat_sessions, so the next Hermes call starts fresh —
// MIN-267 foundation). Effective granularity is 30–35 min, which the spec
// accepts.
//
// The Japanese archive note (ARCHIVE_NOTES.idle_ttl) has no reply token at
// TTL expiry, so it must be a PUSH message — one per idle conversation,
// counted against the LINE plan's monthly quota (200/mo free). That is why
// the note sits behind the IDLE_ARCHIVE_NOTE env flag ('off'/'false'/'0'
// disables it); archiving itself is free and always runs.
//
// Activity deliberately counts outgoing messages too: an operator mid-
// conversation keeps the session alive even when the user is briefly quiet,
// so the new-session note never fires in the middle of a manual exchange.

import { jstNow, toJstString } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { ARCHIVE_NOTES, archiveActiveSession, sendSystemNote } from './chat-sessions.js';

export const IDLE_TTL_MINUTES = 30;

const NON_TEST_MESSAGES = `(delivery_type IS NULL OR delivery_type != 'test')`;

// Sessions opened before any message exists fall back to started_at.
// Valid on both SQLite and Postgres; timestamps are lexicographically
// ordered jstNow() strings, so plain string comparison is correct.
const IDLE_SESSIONS_SQL = `
  SELECT s.friend_id, f.line_user_id, f.line_account_id
  FROM chat_sessions s
  JOIN friends f ON f.id = s.friend_id
  WHERE s.archived_at IS NULL
    AND COALESCE(
      (SELECT MAX(m.created_at) FROM messages_log m
       WHERE m.friend_id = s.friend_id AND ${NON_TEST_MESSAGES}),
      s.started_at
    ) < ?`;

interface IdleSessionRow {
  friend_id: string;
  line_user_id: string;
  line_account_id: string | null;
}

export function idleArchiveNoteEnabled(flag: string | undefined): boolean {
  return !['off', 'false', '0'].includes((flag ?? 'on').trim().toLowerCase());
}

/**
 * Archive every session idle for IDLE_TTL_MINUTES and (when sendNote) push
 * the Japanese idle-archive note. Per-session failures are logged and
 * counted, never aborting the sweep.
 */
export async function archiveIdleSessions(
  db: D1Database,
  opts: {
    defaultLineClient: LineClient;
    lineClients: Map<string, LineClient>;
    sendNote: boolean;
    now?: string;
  },
): Promise<{ archived: number; notesSent: number; failed: number }> {
  const now = opts.now ?? jstNow();
  const cutoff = toJstString(new Date(new Date(now).getTime() - IDLE_TTL_MINUTES * 60_000));

  const idle = await db.prepare(IDLE_SESSIONS_SQL).bind(cutoff).all<IdleSessionRow>();
  const rows = idle.results ?? [];

  let archived = 0;
  let notesSent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await archiveActiveSession(db, row.friend_id, 'idle_ttl', now);
      if (!result) continue;
      archived++;

      if (!opts.sendNote) continue;
      // Friends on a named account push through that account's bot; the
      // env-token default client only covers accountless friends. An account
      // missing from the map is inactive — archive only, never push from
      // the wrong bot.
      const client = row.line_account_id
        ? opts.lineClients.get(row.line_account_id)
        : opts.defaultLineClient;
      if (!client) continue;

      await sendSystemNote({
        db,
        lineClient: client,
        friendId: row.friend_id,
        lineUserId: row.line_user_id,
        lineAccountId: row.line_account_id,
        text: ARCHIVE_NOTES.idle_ttl,
        // Log the note at the archive boundary so it renders inside the
        // archived segment (created_at <= archived_at) in the admin UI.
        createdAt: result.archivedAt,
      });
      notesSent++;
    } catch (err) {
      failed++;
      console.error(`[idle-session-archiver] friend ${row.friend_id}:`, err);
    }
  }
  return { archived, notesSent, failed };
}
