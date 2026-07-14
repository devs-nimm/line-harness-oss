import { describe, expect, test, vi } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

import { ARCHIVE_NOTES } from './chat-sessions.js';
import {
  IDLE_TTL_MINUTES,
  archiveIdleSessions,
  idleArchiveNoteEnabled,
} from './idle-session-archiver.js';

/**
 * Fake D1 keyed by SQL fragment (same pattern as chat-sessions.test.ts):
 * `allResults`/`firstResults` map a substring of the SQL to what
 * `all()`/`first()` resolve to; `runs` records every write.
 */
function makeDb(opts: {
  allResults?: Record<string, unknown[]>;
  firstResults?: Record<string, unknown>;
}) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const binds: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          bound = params;
          binds.push({ sql, params });
          return stmt;
        },
        all: vi.fn(async () => {
          for (const [fragment, results] of Object.entries(opts.allResults ?? {})) {
            if (sql.includes(fragment)) return { results };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          for (const [fragment, value] of Object.entries(opts.firstResults ?? {})) {
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
  return { db, runs, binds };
}

function makeLineClient(pushError?: Error) {
  return {
    replyMessage: vi.fn(async () => ({})),
    pushMessage: vi.fn(async () => {
      if (pushError) throw pushError;
      return {};
    }),
  } as unknown as LineClient;
}

const NOW = '2026-07-14T12:00:00.000+09:00';
const IDLE_ROW = { friend_id: 'friend-1', line_user_id: 'U1', line_account_id: 'acc-1' };
// firstResults that make archiveActiveSession take the active-row path.
const ACTIVE_SESSION = { 'archived_at IS NULL LIMIT 1': { id: 'session-1' } };

describe('idleArchiveNoteEnabled', () => {
  test('defaults on, disabled by off/false/0 (case-insensitive)', () => {
    expect(idleArchiveNoteEnabled(undefined)).toBe(true);
    expect(idleArchiveNoteEnabled('on')).toBe(true);
    expect(idleArchiveNoteEnabled('off')).toBe(false);
    expect(idleArchiveNoteEnabled(' OFF ')).toBe(false);
    expect(idleArchiveNoteEnabled('false')).toBe(false);
    expect(idleArchiveNoteEnabled('0')).toBe(false);
  });
});

describe('archiveIdleSessions', () => {
  test('archives idle session and pushes the idle note at the archive boundary', async () => {
    const { db, runs, binds } = makeDb({
      allResults: { 'FROM chat_sessions s': [IDLE_ROW] },
      firstResults: ACTIVE_SESSION,
    });
    const client = makeLineClient();
    const result = await archiveIdleSessions(db, {
      defaultLineClient: makeLineClient(),
      lineClients: new Map([['acc-1', client]]),
      sendNote: true,
      now: NOW,
    });

    expect(result).toEqual({ archived: 1, notesSent: 1, failed: 0 });

    // Sweep cutoff is NOW - 30 min in jstNow() format.
    const sweep = binds.find((b) => b.sql.includes('FROM chat_sessions s'));
    expect(sweep!.params).toEqual(['2026-07-14T11:30:00.000+09:00']);
    expect(IDLE_TTL_MINUTES).toBe(30);

    // Archived with reason idle_ttl + ai_chat_sessions cleared.
    const update = runs.find((r) => r.sql.includes('UPDATE chat_sessions'));
    expect(update!.params).toEqual([NOW, 'idle_ttl', 'session-1']);
    expect(runs.some((r) => r.sql.includes('DELETE FROM ai_chat_sessions'))).toBe(true);

    // Note pushed via the friend's account client (no reply token available).
    expect(client.pushMessage).toHaveBeenCalledWith('U1', [
      { type: 'text', text: ARCHIVE_NOTES.idle_ttl },
    ]);
    // Logged as a push system note at the archive boundary.
    const noteLog = runs.find((r) => r.sql.includes(`'system_note'`));
    expect(noteLog!.params).toContain('push');
    expect(noteLog!.params).toContain(NOW);
  });

  test('sendNote=false archives but never pushes or logs a note', async () => {
    const { db, runs } = makeDb({
      allResults: { 'FROM chat_sessions s': [IDLE_ROW] },
      firstResults: ACTIVE_SESSION,
    });
    const client = makeLineClient();
    const result = await archiveIdleSessions(db, {
      defaultLineClient: client,
      lineClients: new Map([['acc-1', client]]),
      sendNote: false,
      now: NOW,
    });

    expect(result).toEqual({ archived: 1, notesSent: 0, failed: 0 });
    expect(client.pushMessage).not.toHaveBeenCalled();
    expect(runs.some((r) => r.sql.includes(`'system_note'`))).toBe(false);
    expect(runs.some((r) => r.sql.includes('UPDATE chat_sessions'))).toBe(true);
  });

  test('accountless friend pushes via the default client', async () => {
    const { db } = makeDb({
      allResults: {
        'FROM chat_sessions s': [{ ...IDLE_ROW, line_account_id: null }],
      },
      firstResults: ACTIVE_SESSION,
    });
    const defaultClient = makeLineClient();
    const result = await archiveIdleSessions(db, {
      defaultLineClient: defaultClient,
      lineClients: new Map(),
      sendNote: true,
      now: NOW,
    });

    expect(result).toEqual({ archived: 1, notesSent: 1, failed: 0 });
    expect(defaultClient.pushMessage).toHaveBeenCalled();
  });

  test('inactive account (missing from client map): archives, skips the note', async () => {
    const { db, runs } = makeDb({
      allResults: { 'FROM chat_sessions s': [IDLE_ROW] },
      firstResults: ACTIVE_SESSION,
    });
    const defaultClient = makeLineClient();
    const result = await archiveIdleSessions(db, {
      defaultLineClient: defaultClient,
      lineClients: new Map(),
      sendNote: true,
      now: NOW,
    });

    expect(result).toEqual({ archived: 1, notesSent: 0, failed: 0 });
    expect(defaultClient.pushMessage).not.toHaveBeenCalled();
    expect(runs.some((r) => r.sql.includes('UPDATE chat_sessions'))).toBe(true);
  });

  test('push failure is counted and does not abort the sweep', async () => {
    const rows = [
      { friend_id: 'friend-1', line_user_id: 'U1', line_account_id: 'acc-bad' },
      { friend_id: 'friend-2', line_user_id: 'U2', line_account_id: 'acc-ok' },
    ];
    const { db, runs } = makeDb({
      allResults: { 'FROM chat_sessions s': rows },
      firstResults: ACTIVE_SESSION,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const okClient = makeLineClient();
    const result = await archiveIdleSessions(db, {
      defaultLineClient: makeLineClient(),
      lineClients: new Map([
        ['acc-bad', makeLineClient(new Error('LINE API error: 429'))],
        ['acc-ok', okClient],
      ]),
      sendNote: true,
      now: NOW,
    });
    errSpy.mockRestore();

    // Both archived (archive precedes the note); one note sent, one failed.
    expect(result).toEqual({ archived: 2, notesSent: 1, failed: 1 });
    expect(okClient.pushMessage).toHaveBeenCalledWith('U2', [
      { type: 'text', text: ARCHIVE_NOTES.idle_ttl },
    ]);
    expect(runs.filter((r) => r.sql.includes('UPDATE chat_sessions'))).toHaveLength(2);
  });

  test('no idle sessions: no writes', async () => {
    const { db, runs } = makeDb({});
    const result = await archiveIdleSessions(db, {
      defaultLineClient: makeLineClient(),
      lineClients: new Map(),
      sendNote: true,
      now: NOW,
    });
    expect(result).toEqual({ archived: 0, notesSent: 0, failed: 0 });
    expect(runs).toHaveLength(0);
  });
});
