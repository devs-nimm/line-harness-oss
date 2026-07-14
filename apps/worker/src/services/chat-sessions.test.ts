import { describe, expect, test, vi } from 'vitest';

import {
  ARCHIVE_NOTES,
  NEW_SESSION_NOTE,
  archiveActiveSession,
  openSessionIfNeeded,
  sendSystemNote,
} from './chat-sessions.js';

/**
 * Fake D1 keyed by SQL fragment: `firstResults` maps a substring of the SQL
 * to what `first()` resolves to; `runs` records every write for assertions.
 */
function makeDb(firstResults: Record<string, unknown> = {}) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          bound = params;
          return stmt;
        },
        first: vi.fn(async () => {
          for (const [fragment, value] of Object.entries(firstResults)) {
            if (sql.includes(fragment)) return value;
          }
          return null;
        }),
        run: vi.fn(async () => {
          runs.push({ sql, params: bound });
          return {};
        }),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, runs };
}

const NOW = '2026-07-14T12:00:00.000+09:00';

describe('openSessionIfNeeded', () => {
  test('opens a session when none is active and reports archived history', async () => {
    const { db, runs } = makeDb({
      'archived_at IS NULL LIMIT 1': null,
      'archived_at IS NOT NULL LIMIT 1': { id: 'old-session' },
    });

    await expect(openSessionIfNeeded(db, 'friend-1', 'acc-1', NOW)).resolves.toEqual({
      opened: true,
      hasArchived: true,
    });
    const insert = runs.find((r) => r.sql.includes('INSERT INTO chat_sessions'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('ON CONFLICT DO NOTHING');
    // (id, friend_id, line_account_id, started_at, created_at, friend_id)
    expect(insert!.params.slice(1)).toEqual(['friend-1', 'acc-1', NOW, NOW, 'friend-1']);
  });

  test('no-op when an active session exists', async () => {
    const { db, runs } = makeDb({
      'archived_at IS NULL LIMIT 1': { id: 'active-session' },
      'archived_at IS NOT NULL LIMIT 1': null,
    });

    await expect(openSessionIfNeeded(db, 'friend-1', null, NOW)).resolves.toEqual({
      opened: false,
      hasArchived: false,
    });
    expect(runs).toHaveLength(0);
  });

  test('first-ever session reports no archived history (no note for new friends)', async () => {
    const { db } = makeDb({});

    await expect(openSessionIfNeeded(db, 'friend-1', null, NOW)).resolves.toEqual({
      opened: true,
      hasArchived: false,
    });
  });
});

describe('archiveActiveSession', () => {
  test('archives the active session and clears ai_chat_sessions', async () => {
    const { db, runs } = makeDb({
      'archived_at IS NULL LIMIT 1': { id: 'active-session' },
    });

    await expect(archiveActiveSession(db, 'friend-1', 'user_new', NOW)).resolves.toEqual({
      archivedAt: NOW,
    });
    const update = runs.find((r) => r.sql.includes('UPDATE chat_sessions'));
    expect(update?.params).toEqual([NOW, 'user_new', 'active-session']);
    expect(runs.some((r) => r.sql.includes('DELETE FROM ai_chat_sessions'))).toBe(true);
  });

  test('retro-creates an archived session for legacy messages without a session row', async () => {
    const { db, runs } = makeDb({
      'archived_at IS NULL LIMIT 1': null,
      'MAX(archived_at)': { boundary: null },
      'MIN(created_at)': { first_at: '2026-07-01T09:00:00.000+09:00' },
    });

    await expect(archiveActiveSession(db, 'friend-1', 'admin_delete', NOW)).resolves.toEqual({
      archivedAt: NOW,
    });
    const insert = runs.find((r) => r.sql.includes('INSERT INTO chat_sessions'));
    // (id, friend_id, started_at, archived_at, reason, created_at)
    expect(insert?.params.slice(1)).toEqual([
      'friend-1',
      '2026-07-01T09:00:00.000+09:00',
      NOW,
      'admin_delete',
      NOW,
    ]);
    expect(runs.some((r) => r.sql.includes('DELETE FROM ai_chat_sessions'))).toBe(true);
  });

  test('returns null but still clears ai_chat_sessions when there is nothing to archive', async () => {
    const { db, runs } = makeDb({
      'archived_at IS NULL LIMIT 1': null,
      'MAX(archived_at)': { boundary: null },
      'MIN(created_at)': { first_at: null },
    });

    await expect(archiveActiveSession(db, 'friend-1', 'idle_ttl', NOW)).resolves.toBeNull();
    expect(runs.some((r) => r.sql.includes('INSERT INTO chat_sessions'))).toBe(false);
    expect(runs.some((r) => r.sql.includes('DELETE FROM ai_chat_sessions'))).toBe(true);
  });
});

describe('sendSystemNote', () => {
  const NOTE_ARGS = {
    friendId: 'friend-1',
    lineUserId: 'U1',
    lineAccountId: 'acc-1',
    text: NEW_SESSION_NOTE,
    createdAt: NOW,
  };

  test('replies when a token is available and logs source=system_note', async () => {
    const { db, runs } = makeDb();
    const lineClient = {
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      sendSystemNote({ db, lineClient, replyToken: 'reply-token', ...NOTE_ARGS }),
    ).resolves.toBe('reply');
    expect(lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: NEW_SESSION_NOTE },
    ]);
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    const log = runs.find((r) => r.sql.includes('messages_log'));
    expect(log?.sql).toContain("'system_note'");
    expect(log?.params).toContain(NEW_SESSION_NOTE);
    expect(log?.params).toContain('reply');
  });

  test('falls back to push when the reply token is expired', async () => {
    const { db, runs } = makeDb();
    const lineClient = {
      replyMessage: vi.fn().mockRejectedValue(new Error('Invalid reply token')),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      sendSystemNote({ db, lineClient, replyToken: 'reply-token', ...NOTE_ARGS }),
    ).resolves.toBe('push');
    expect(lineClient.pushMessage).toHaveBeenCalledWith('U1', [
      { type: 'text', text: NEW_SESSION_NOTE },
    ]);
    const log = runs.find((r) => r.sql.includes('messages_log'));
    expect(log?.params).toContain('push');
  });

  test('pushes directly when no reply token is available', async () => {
    const { db } = makeDb();
    const lineClient = {
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    };

    await sendSystemNote({ db, lineClient, ...NOTE_ARGS, text: ARCHIVE_NOTES.idle_ttl });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).toHaveBeenCalledWith('U1', [
      { type: 'text', text: ARCHIVE_NOTES.idle_ttl },
    ]);
  });
});
