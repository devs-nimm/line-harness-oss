/**
 * Integration tests for the PostgreSQL D1 adapter (MIN-257).
 *
 * Requires a real PostgreSQL and is DESTRUCTIVE to it (drops the public
 * schema), so it only runs when TEST_DATABASE_URL is set:
 *
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://postgres:change-me@localhost:5432/linecrm pnpm --filter @line-crm/db test
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgD1Database } from '../src/pg/adapter';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe.skipIf(!TEST_DATABASE_URL)('createPgD1Database (real PostgreSQL)', () => {
  let pool: pg.Pool;
  let db: D1Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query(readFileSync(join(PKG_ROOT, 'postgres', 'migrations', '0001_init.sql'), 'utf8'));
    db = createPgD1Database(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('runs insert / first / all with ? placeholders', async () => {
    const ins = await db
      .prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?, ?, ?)`)
      .bind('f1', 'U1', 'Alice')
      .run();
    expect(ins.success).toBe(true);
    expect(ins.meta.changes).toBe(1);

    const row = await db
      .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
      .bind('U1')
      .first<{ id: string; display_name: string; is_following: number; created_at: string }>();
    expect(row?.id).toBe('f1');
    expect(row?.display_name).toBe('Alice');
    expect(row?.is_following).toBe(1);
    // D1-style TEXT timestamp default (JST): 2026-07-14T02:44:38.499
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);

    const all = await db.prepare(`SELECT id FROM friends ORDER BY id`).all<{ id: string }>();
    expect(all.results).toEqual([{ id: 'f1' }]);
  });

  it('returns numbers for COUNT/AVG like D1', async () => {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c, AVG(score) AS a FROM friends`)
      .first<{ c: number; a: number }>();
    expect(row?.c).toBe(1);
    expect(typeof row?.c).toBe('number');
    expect(typeof row?.a).toBe('number');
  });

  it('reports meta.changes = 0 for ON CONFLICT DO NOTHING duplicates', async () => {
    await db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).bind('t1', 'vip').run();
    await db
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .bind('f1', 't1')
      .run();
    const dup = await db
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .bind('f1', 't1')
      .run();
    expect(dup.meta.changes).toBe(0);
  });

  it('supports ON CONFLICT ... DO UPDATE upserts', async () => {
    await db
      .prepare(
        `INSERT INTO account_settings (id, line_account_id, key, value, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      )
      .bind('s1', '__global__', 'k', 'v1', 'v1')
      .run();
    const upd = await db
      .prepare(
        `INSERT INTO account_settings (id, line_account_id, key, value, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      )
      .bind('s2', '__global__', 'k', 'v2', 'v2')
      .run();
    expect(upd.meta.changes).toBe(1);
    const row = await db
      .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
      .bind('__global__', 'k')
      .first<{ value: string }>();
    expect(row?.value).toBe('v2');
  });

  it('coerces boolean binds to INTEGER 0/1', async () => {
    await db
      .prepare(`UPDATE friends SET is_following = ? WHERE id = ?`)
      .bind(false, 'f1')
      .run();
    const row = await db
      .prepare(`SELECT is_following FROM friends WHERE id = ?`)
      .bind('f1')
      .first<{ is_following: number }>();
    expect(row?.is_following).toBe(0);
    await db.prepare(`UPDATE friends SET is_following = 1 WHERE id = ?`).bind('f1').run();
  });

  it('evaluates julianday() hours-since arithmetic (conversations.ts pattern)', async () => {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
         VALUES (?, ?, 'incoming', 'text', 'hi', strftime('%Y-%m-%dT%H:%M:%f', 'now', '-2 hours'))`,
      )
      .bind('m1', 'f1')
      .run();
    const row = await db
      .prepare(
        `SELECT (julianday('now') - julianday(created_at)) * 24.0 AS hours_since
         FROM messages_log WHERE id = ?`,
      )
      .bind('m1')
      .first<{ hours_since: number }>();
    expect(row?.hours_since).toBeGreaterThan(1.9);
    expect(row?.hours_since).toBeLessThan(2.1);
  });

  it('filters by json_each membership (events.ts account_ids pattern)', async () => {
    await db
      .prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('acc1', 'ch1', 'main', 'token', 'secret')
      .run();
    await db
      .prepare(`INSERT INTO events (id, line_account_id, name, account_ids) VALUES (?, ?, ?, ?)`)
      .bind('e1', 'acc1', 'seminar', JSON.stringify(['acc1', 'acc2']))
      .run();
    const hit = await db
      .prepare(
        `SELECT id FROM events
         WHERE account_ids IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?)`,
      )
      .bind('acc2')
      .first<{ id: string }>();
    expect(hit?.id).toBe('e1');
    const miss = await db
      .prepare(
        `SELECT id FROM events
         WHERE account_ids IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?)`,
      )
      .bind('acc3')
      .first<{ id: string }>();
    expect(miss).toBeNull();
  });

  it('reads json_extract() paths from friend metadata (segment-query pattern)', async () => {
    await db
      .prepare(`UPDATE friends SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ plan: 'gold', nested: { a: 1 } }), 'f1')
      .run();
    const row = await db
      .prepare(`SELECT id FROM friends WHERE json_extract(metadata, '$.' || ?) = ?`)
      .bind('plan', 'gold')
      .first<{ id: string }>();
    expect(row?.id).toBe('f1');
    const nested = await db
      .prepare(`SELECT json_extract(metadata, ?) AS v FROM friends WHERE id = ?`)
      .bind('$.nested.a', 'f1')
      .first<{ v: string }>();
    expect(nested?.v).toBe('1');
  });

  it('runs batch() in a single transaction', async () => {
    const ok = await db.batch([
      db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).bind('t2', 'batch-a'),
      db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).bind('t3', 'batch-b'),
    ]);
    expect(ok).toHaveLength(2);
    expect(ok[1].meta.changes).toBe(1);

    // Second statement violates UNIQUE(name) → whole batch rolls back.
    await expect(
      db.batch([
        db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).bind('t4', 'batch-c'),
        db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).bind('t5', 'batch-a'),
      ]),
    ).rejects.toThrow();
    const gone = await db.prepare(`SELECT id FROM tags WHERE id = ?`).bind('t4').first();
    expect(gone).toBeNull();
  });

  it('keeps ? inside string literals out of the parameter list', async () => {
    const row = await db
      .prepare(`SELECT id FROM friends WHERE COALESCE(picture_url, 'none?') != ? AND id = ?`)
      .bind('x', 'f1')
      .first<{ id: string }>();
    expect(row?.id).toBe('f1');
  });

  it('supports the date(start of month) window (line-accounts.ts pattern)', async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages_log
         WHERE created_at >= date('now', 'start of month')`,
      )
      .first<{ c: number }>();
    expect(typeof row?.c).toBe('number');
  });
});
