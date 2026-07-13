#!/usr/bin/env node
// One-off data migration: Cloudflare D1 → PostgreSQL (MIN-257).
//
// 1. Export the existing D1 database (data only):
//      npx wrangler d1 export <your-database> --remote --no-schema --output d1-dump.sql
// 2. Create the PostgreSQL schema:
//      DATABASE_URL=... node packages/db/scripts/pg-migrate.mjs
// 3. Transform and import the data:
//      node scripts/d1-to-postgres.mjs d1-dump.sql | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f -
//
// The transform keeps INSERT statements only (skipping SQLite bookkeeping
// tables), rewrites SQLite's char()/randomblob-free dump syntax where needed,
// and defers all FK checks so dump order does not matter (every FK in the
// generated schema is DEFERRABLE).

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/d1-to-postgres.mjs <d1-dump.sql>');
  process.exit(1);
}

const SKIP_TABLES = new Set(['sqlite_sequence', 'd1_migrations', '_cf_kv', 'schema_migrations']);

const dump = readFileSync(file, 'utf8');

/** Split SQL into statements on top-level semicolons (quote-aware). */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      current += c;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            current += sql[i + 1];
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
      if (end === -1) break;
      i = end;
    } else if (c === ';') {
      statements.push(current.trim());
      current = '';
      i++;
    } else {
      current += c;
      i++;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Replace an identifier-like token when it appears outside quotes. */
function replaceOutsideQuotes(stmt, from, to) {
  let out = '';
  let i = 0;
  while (i < stmt.length) {
    const c = stmt[i];
    if (c === "'" || c === '"') {
      out += c;
      i++;
      while (i < stmt.length) {
        out += stmt[i];
        if (stmt[i] === c) {
          if (stmt[i + 1] === c) {
            out += stmt[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (stmt.startsWith(from, i)) {
      out += to;
      i += from.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const out = ['BEGIN;', 'SET CONSTRAINTS ALL DEFERRED;'];
let kept = 0;
let skipped = 0;

for (const stmt of splitStatements(dump)) {
  const m = stmt.match(/^INSERT INTO\s+"?([A-Za-z0-9_]+)"?/i);
  if (!m) {
    skipped++;
    continue; // CREATE TABLE / PRAGMA / BEGIN / COMMIT / index DDL
  }
  if (SKIP_TABLES.has(m[1].toLowerCase())) {
    skipped++;
    continue;
  }
  let s = stmt;
  // sqlite3 CLI dumps embed newlines via replace(...,'\n',char(10)); PostgreSQL
  // spells the function chr().
  if (/char\(1[03]\)/.test(s)) {
    s = replaceOutsideQuotes(s, 'char(10)', 'chr(10)');
    s = replaceOutsideQuotes(s, 'char(13)', 'chr(13)');
  }
  out.push(s + ';');
  kept++;
}

out.push('COMMIT;');
process.stdout.write(out.join('\n') + '\n');
console.error(`kept ${kept} INSERT statement(s), skipped ${skipped} other statement(s)`);
