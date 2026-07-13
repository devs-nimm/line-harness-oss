#!/usr/bin/env node
// PostgreSQL migration runner: applies packages/db/postgres/migrations/*.sql
// in filename order, once each, recording applied files in schema_migrations.
// Each migration runs inside its own transaction.
//
// Usage: DATABASE_URL=postgres://user:pass@host:5432/db node scripts/pg-migrate.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'postgres', 'migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required, e.g. postgres://postgres:postgres@localhost:5432/linecrm');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const applied = new Set(
    (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`migration failed: ${file}`);
      throw error;
    }
    console.log(`applied ${file}`);
    ran++;
  }
  console.log(ran === 0 ? 'up to date' : `applied ${ran} migration(s)`);
} finally {
  await client.end();
}
