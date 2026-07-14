/**
 * Real-PostgreSQL integration tests for the queries the D1→PG migration broke
 * (MIN-263): SQLite bare-column argmax rewritten as ROW_NUMBER, LIMIT -1 →
 * INT32_MAX, HAVING alias → aggregate expression.
 *
 * The worker's unit tests mock the DB, which is exactly why these queries
 * shipped broken — this suite runs the real SQL against a real Postgres so
 * the SQLite-only idioms can't silently regress again.
 *
 * Requires a real PostgreSQL and is DESTRUCTIVE to it (drops the public
 * schema), so it only runs when TEST_DATABASE_URL is set. Point it at a
 * dedicated test database, never the live one:
 *
 *   TEST_DATABASE_URL=postgres://postgres:change-me@localhost:5432/linecrm_test \
 *     pnpm --filter worker test src/routes/pg-compat.pg.test.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Hono } from 'hono';
import { createPgD1Database } from '@line-crm/db/src/pg/adapter.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/db/postgres/migrations/0001_init.sql',
);

describe.skipIf(!TEST_DATABASE_URL)('MIN-263 argmax queries on real PostgreSQL', () => {
  let pool: pg.Pool;
  let db: D1Database;
  let app: Hono;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query(readFileSync(MIGRATION_PATH, 'utf8'));
    db = createPgD1Database(pool);

    const { chats } = await import('./chats.js');
    const { conversations } = await import('./conversations.js');
    app = new Hono();
    app.use('*', async (c, next) => {
      c.env = { DB: db };
      await next();
    });
    app.route('/', chats);
    app.route('/', conversations);

    await seed();
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  // Fixture (all timestamps in D1's TEXT format, JST-naive like production).
  // chats has a UNIQUE(friend_id) index (048) so one row per friend:
  //   f1 — incoming 'hello' then a newer outgoing broadcast; chat unread →
  //        unanswered. Preview must be the incoming, not the newer broadcast.
  //   f2 — incoming; chat resolved → excluded from unanswered.
  //   f3 — incoming then a manual reply after it → answered → excluded.
  async function seed() {
    const stmts = [
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc1', 'ch1', 'Main', 'tok', 'sec')`,
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES
       ('f1', 'U1', 'Alice', 'acc1'),
       ('f2', 'U2', 'Bob', 'acc1'),
       ('f3', 'U3', 'Carol', 'acc1')`,
      `INSERT INTO chats (id, friend_id, status, created_at, updated_at) VALUES
       ('c1', 'f1', 'unread',   '2026-07-02T00:00:00.000', '2026-07-02T00:00:00.000'),
       ('c2', 'f2', 'resolved', '2026-07-02T00:00:00.000', '2026-07-02T00:00:00.000')`,
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, created_at) VALUES
       ('m1', 'f1', 'incoming', 'text', 'hello', NULL, '2026-07-03T00:00:00.000'),
       ('m2', 'f1', 'outgoing', 'text', 'campaign!', 'broadcast', '2026-07-03T01:00:00.000'),
       ('m3', 'f2', 'incoming', 'text', 'hi there', NULL, '2026-07-03T00:00:00.000'),
       ('m4', 'f3', 'incoming', 'text', 'question', NULL, '2026-07-01T00:00:00.000'),
       ('m5', 'f3', 'outgoing', 'text', 'answer', 'manual', '2026-07-02T00:00:00.000')`,
    ];
    for (const sql of stmts) await db.prepare(sql).run();
  }

  it('countUnanswered runs on PG and honors the latest chats.status', async () => {
    const { countUnanswered } = await import('../services/unanswered-inbox.js');
    const count = await countUnanswered(db);
    // f1 only: f2's latest chats row is resolved, f3 was answered manually.
    expect(count.total).toBe(1);
    expect(count.byAccount).toEqual([{ accountId: 'acc1', accountName: 'Main', count: 1 }]);
  });

  it('computeUnansweredInbox returns the f1 row with its incoming preview', async () => {
    const { computeUnansweredInbox } = await import('../services/unanswered-inbox.js');
    const inbox = await computeUnansweredInbox(db);
    expect(inbox.total).toBe(1);
    expect(inbox.rows[0]).toMatchObject({
      friendId: 'f1',
      lastIncomingContent: 'hello',
      lastIncomingType: 'text',
    });
  });

  it('GET /api/chats runs on PG and prefers the latest incoming as preview', async () => {
    const res = await app.request('/api/chats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<Record<string, unknown>> };
    expect(body.success).toBe(true);
    const byId = new Map(body.data.map((r) => [r.id as string, r]));
    expect(byId.size).toBe(3);
    // in_agg beats any_agg: preview is the incoming 'hello', not the newer broadcast.
    expect(byId.get('f1')).toMatchObject({
      lastMessageContent: 'hello',
      lastMessageDirection: 'incoming',
      status: 'unread',
    });
    // f2's latest chats row wins → resolved.
    expect(byId.get('f2')).toMatchObject({ status: 'resolved' });
  });

  it('GET /api/chats?unansweredOnly=true exercises the no-limit path on PG', async () => {
    const res = await app.request('/api/chats?unansweredOnly=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<Record<string, unknown>> };
    expect(body.success).toBe(true);
    expect(body.data.map((r) => r.id)).toEqual(['f1']);
  });

  it('GET /api/conversations runs on PG (items + count query)', async () => {
    const res = await app.request('/api/conversations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: Array<Record<string, unknown>>; total: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.items.map((r) => r.friendId)).toEqual(['f1']);
  });

  it('computeDuplicatesStats runs on PG (HAVING must not reference a SELECT alias)', async () => {
    const { computeDuplicatesStats } = await import('../services/duplicates-stats.js');
    const stats = await computeDuplicatesStats(db, { forceRefresh: true });
    expect(stats.total_following).toBe(3);
  });
});
