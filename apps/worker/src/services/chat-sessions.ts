// Conversation sessions with archive (MIN-267).
//
// Each friend has at most one ACTIVE chat_sessions row (archived_at IS NULL).
// Three triggers archive it — "/new" from the LINE user (webhook.ts), the
// 30-min idle TTL (MIN-265), and admin delete (MIN-266) — and the next
// incoming message opens a fresh session.
//
// Messages are associated to sessions by timestamp range: a message with
// created_at <= an archived_at boundary belongs to that (or an earlier)
// archived session. There is deliberately NO session_id column on
// messages_log — every existing write path (broadcast / scenario / manual /
// forms) keeps working unchanged and legacy rows need no backfill. The
// tradeoff: association is implicit and relies on jstNow()'s
// lexicographically ordered timestamps.
//
// System notes (the Japanese archive / new-session notices) are logged with
// source='system_note' and are NEVER part of any LLM input: the Hermes
// /responses call only ever sends the incoming text (openai-auto-reply.ts).
// The dedicated source keeps them out of any future context-building and
// lets the admin UI render them as system dividers, not operator messages.

import { jstNow } from '@line-crm/db';

export type ArchiveReason = 'admin_delete' | 'idle_ttl' | 'user_new';

// Note (1) — sent when a session is archived; wording varies by trigger.
export const ARCHIVE_NOTES: Record<ArchiveReason, string> = {
  admin_delete: 'オペレーターにより、これまでの会話履歴がアーカイブされました。',
  idle_ttl: '30分間メッセージがなかったため、会話をアーカイブしました。',
  user_new: 'ご要望により、これまでの会話をアーカイブしました。',
};

// Note (2) — sent on the first message of the new session.
export const NEW_SESSION_NOTE = '新しい会話を開始しました。以前の会話内容は引き継がれません。';

const NON_TEST_MESSAGES = `(delivery_type IS NULL OR delivery_type != 'test')`;

export function isReplyTokenExpiredError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err && err.status === 400) {
    return true;
  }
  const errMsg = err instanceof Error ? err.message : String(err);
  const statusMatch = /^LINE API error: (\d+)/.exec(errMsg);
  if (statusMatch) {
    return statusMatch[1] === '400';
  }
  return errMsg.includes('Invalid reply token');
}

/**
 * Ensure the friend has an active session; lazily opens one on the first
 * incoming message after an archive (or ever). Returns whether a new session
 * was opened and whether any archived session exists — the caller sends the
 * NEW_SESSION_NOTE only when both are true (a brand-new friend's first
 * session must not produce a note).
 */
export async function openSessionIfNeeded(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
  now: string = jstNow(),
): Promise<{ opened: boolean; hasArchived: boolean }> {
  const active = await db
    .prepare(`SELECT id FROM chat_sessions WHERE friend_id = ? AND archived_at IS NULL LIMIT 1`)
    .bind(friendId)
    .first<{ id: string }>();
  const archived = await db
    .prepare(`SELECT id FROM chat_sessions WHERE friend_id = ? AND archived_at IS NOT NULL LIMIT 1`)
    .bind(friendId)
    .first<{ id: string }>();
  if (active) return { opened: false, hasArchived: archived != null };

  // Atomic against concurrent webhook deliveries: partial unique index on
  // (friend_id) WHERE archived_at IS NULL + ON CONFLICT DO NOTHING.
  await db
    .prepare(
      `INSERT INTO chat_sessions (id, friend_id, line_account_id, started_at, archived_at, archive_reason, created_at)
       SELECT ?, ?, ?, ?, NULL, NULL, ?
       WHERE NOT EXISTS (SELECT 1 FROM chat_sessions WHERE friend_id = ? AND archived_at IS NULL) ON CONFLICT DO NOTHING`,
    )
    .bind(crypto.randomUUID(), friendId, lineAccountId, now, now, friendId)
    .run();
  return { opened: true, hasArchived: archived != null };
}

/**
 * Archive the friend's active session (if any) and clear the ai_chat_sessions
 * row so the next Hermes call can never reuse the old previous_response_id.
 *
 * Legacy conversations (messages that predate this feature, or that arrived
 * while no session was open) have no active row to archive; if such messages
 * exist past the last archive boundary, an already-archived row is created
 * retroactively so the admin UI shows the segment and the next message
 * triggers the new-session note.
 *
 * Returns the boundary timestamp, or null when there was nothing to archive.
 */
export async function archiveActiveSession(
  db: D1Database,
  friendId: string,
  reason: ArchiveReason,
  now: string = jstNow(),
): Promise<{ archivedAt: string } | null> {
  const active = await db
    .prepare(`SELECT id FROM chat_sessions WHERE friend_id = ? AND archived_at IS NULL LIMIT 1`)
    .bind(friendId)
    .first<{ id: string }>();

  let archivedAt: string | null = null;
  if (active) {
    await db
      .prepare(`UPDATE chat_sessions SET archived_at = ?, archive_reason = ? WHERE id = ? AND archived_at IS NULL`)
      .bind(now, reason, active.id)
      .run();
    archivedAt = now;
  } else {
    const lastBoundary = await db
      .prepare(`SELECT MAX(archived_at) AS boundary FROM chat_sessions WHERE friend_id = ?`)
      .bind(friendId)
      .first<{ boundary: string | null }>();
    const firstMsg = lastBoundary?.boundary
      ? await db
          .prepare(
            `SELECT MIN(created_at) AS first_at FROM messages_log
             WHERE friend_id = ? AND created_at > ? AND ${NON_TEST_MESSAGES}`,
          )
          .bind(friendId, lastBoundary.boundary)
          .first<{ first_at: string | null }>()
      : await db
          .prepare(
            `SELECT MIN(created_at) AS first_at FROM messages_log
             WHERE friend_id = ? AND ${NON_TEST_MESSAGES}`,
          )
          .bind(friendId)
          .first<{ first_at: string | null }>();
    if (firstMsg?.first_at) {
      await db
        .prepare(
          `INSERT INTO chat_sessions (id, friend_id, line_account_id, started_at, archived_at, archive_reason, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), friendId, firstMsg.first_at, now, reason, now)
        .run();
      archivedAt = now;
    }
  }

  await db.prepare(`DELETE FROM ai_chat_sessions WHERE friend_id = ?`).bind(friendId).run();
  return archivedAt ? { archivedAt } : null;
}

export async function logSystemNote(
  db: D1Database,
  args: {
    friendId: string;
    text: string;
    deliveryType: 'reply' | 'push';
    lineAccountId: string | null;
    createdAt?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?, 'system_note', ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.friendId,
      args.text,
      args.deliveryType,
      args.lineAccountId,
      args.createdAt ?? jstNow(),
    )
    .run();
}

interface NoteCapableLineClient {
  replyMessage(replyToken: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
  pushMessage(userId: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
}

/**
 * Send a system note to the LINE user (reply when a token is available —
 * zero quota cost — falling back to push on token expiry) and log it with
 * source='system_note'.
 */
export async function sendSystemNote(args: {
  db: D1Database;
  lineClient: NoteCapableLineClient;
  friendId: string;
  lineUserId: string;
  replyToken?: string;
  lineAccountId: string | null;
  text: string;
  createdAt?: string;
}): Promise<'reply' | 'push'> {
  let deliveryType: 'reply' | 'push' = 'push';
  const messages = [{ type: 'text' as const, text: args.text }];
  if (args.replyToken) {
    try {
      await args.lineClient.replyMessage(args.replyToken, messages);
      deliveryType = 'reply';
    } catch (err: unknown) {
      if (!isReplyTokenExpiredError(err)) throw err;
      await args.lineClient.pushMessage(args.lineUserId, messages);
    }
  } else {
    await args.lineClient.pushMessage(args.lineUserId, messages);
  }

  await logSystemNote(args.db, {
    friendId: args.friendId,
    text: args.text,
    deliveryType,
    lineAccountId: args.lineAccountId,
    createdAt: args.createdAt,
  });
  return deliveryType;
}
