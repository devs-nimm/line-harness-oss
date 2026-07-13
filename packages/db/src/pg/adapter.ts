/**
 * D1-compatible adapter over node-postgres (MIN-257).
 *
 * The whole codebase talks to the database through the D1
 * `prepare().bind().all()/first()/run()` surface. This adapter reproduces that
 * surface on top of a pg Pool so call sites stay untouched when running
 * against PostgreSQL instead of Cloudflare D1.
 *
 * Scope notes:
 * - `?` placeholders are rewritten to `$1..$n` outside string literals,
 *   quoted identifiers and comments.
 * - boolean bind params are coerced to 1/0 (the schema keeps D1's INTEGER
 *   booleans), `undefined` binds to NULL.
 * - int8/numeric result columns are parsed to JS numbers, matching D1.
 * - `meta.changes` is the pg rowCount. `meta.last_row_id` is always 0 — the
 *   schema has no rowid/autoincrement keys and no call site reads it.
 * - `batch()` runs its statements inside one transaction, like D1.
 * - `dump()` and `withSession()` are not supported (no call sites exist).
 */

import pg from 'pg';

/** Rewrite SQLite-style `?` placeholders to PostgreSQL `$1..$n`. */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // String literal / quoted identifier; doubled quotes escape themselves.
      out += c;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
    } else if (c === '?') {
      n++;
      out += `$${n}`;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function coerceParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// D1 returns numbers for every numeric column; pg returns strings for int8
// (COUNT(*)) and numeric by default. Set the parsers globally so the behavior
// is identical whether the caller passes a connection string or its own Pool.
// The schema stores no bigints — int8 only shows up in aggregates, where the
// values are far below Number.MAX_SAFE_INTEGER.
const parseNumber = (v: string) => Number(v);
pg.types.setTypeParser(pg.types.builtins.INT8, parseNumber);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseNumber);

interface Queryable {
  query(sql: string, params: unknown[]): Promise<pg.QueryResult>;
}

function d1Meta(result: pg.QueryResult): D1Meta & Record<string, unknown> {
  const changes = result.rowCount ?? 0;
  return {
    duration: 0,
    size_after: 0,
    rows_read: result.rows.length,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes,
  };
}

class PgPreparedStatement {
  constructor(
    private readonly db: Queryable,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): PgPreparedStatement {
    return new PgPreparedStatement(this.db, this.sql, values.map(coerceParam));
  }

  private query(): Promise<pg.QueryResult> {
    return this.db.query(convertPlaceholders(this.sql), this.params);
  }

  async all<T>(): Promise<D1Result<T>> {
    const result = await this.query();
    return { results: result.rows as T[], success: true, meta: d1Meta(result) };
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async first<T>(colName?: string): Promise<T | null> {
    const result = await this.query();
    const row = (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    if (colName !== undefined) {
      return row && colName in row ? (row[colName] as T) : null;
    }
    return row as T | null;
  }

  async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = await this.query();
    const columns = result.fields.map((f) => f.name);
    const rows = result.rows.map((r: Record<string, unknown>) => columns.map((c) => r[c]));
    if (options?.columnNames) return [columns as T, ...(rows as T[])];
    return rows as T[];
  }
}

/**
 * Create a D1Database-compatible handle backed by PostgreSQL.
 *
 * Accepts a connection string (`postgres://user:pass@host:5432/db`) or an
 * existing pg Pool. When given a string, the pool is created with D1-style
 * type parsing (int8/numeric → number).
 */
export function createPgD1Database(source: string | pg.Pool): D1Database {
  const pool = typeof source === 'string' ? new pg.Pool({ connectionString: source }) : source;

  const db = {
    prepare(sql: string) {
      return new PgPreparedStatement(pool, sql) as unknown as D1PreparedStatement;
    },

    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          // Statements produced by this adapter's prepare(); rebind onto the
          // transaction client.
          const s = stmt as unknown as { sql: string; params: unknown[] };
          const result = await client.query(convertPlaceholders(s.sql), s.params);
          results.push({ results: result.rows as T[], success: true, meta: d1Meta(result) });
        }
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async exec(sql: string): Promise<D1ExecResult> {
      await pool.query(sql);
      return { count: 1, duration: 0 };
    },

    async dump(): Promise<ArrayBuffer> {
      throw new Error('D1Database.dump() is not supported by the PostgreSQL adapter');
    },

    withSession(): never {
      throw new Error('D1Database.withSession() is not supported by the PostgreSQL adapter');
    },
  };

  return db as unknown as D1Database;
}
