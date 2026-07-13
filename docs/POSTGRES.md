# PostgreSQL (self-hosted database)

As of MIN-257 the database layer runs on PostgreSQL (docker-compose service)
instead of Cloudflare D1. The application code still speaks the D1
`prepare().bind().all()/first()/run()` API — a thin adapter
(`packages/db/src/pg/adapter.ts`, exported as `createPgD1Database`) maps it
onto a `pg` connection pool, so the ~120 existing call sites are unchanged.

## Fresh install

```bash
cp .env.example .env            # set POSTGRES_PASSWORD
docker compose up -d postgres
DATABASE_URL=postgres://postgres:<password>@localhost:5432/linecrm \
  pnpm db:migrate:pg
```

`pnpm db:migrate:pg` runs `packages/db/scripts/pg-migrate.mjs`: plain ordered
SQL files from `packages/db/postgres/migrations/`, applied once each and
recorded in `schema_migrations`. New schema changes = add the next numbered
file there.

## Migrating data from an existing D1 install

```bash
# 1. Export data from D1 (data only)
npx wrangler d1 export your-database --remote --no-schema --output d1-dump.sql

# 2. Create the schema (above), then transform + import
node scripts/d1-to-postgres.mjs d1-dump.sql | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -
```

The importer keeps only INSERT statements (drops SQLite bookkeeping tables),
runs everything in one transaction with all FK checks deferred (every FK in
the generated schema is DEFERRABLE), and translates the few SQLite-isms
`wrangler d1 export` can emit (`char(10)` → `chr(10)`). Positional
`INSERT INTO t VALUES(...)` statements assume the exported D1 database is on
the current schema — run all D1 migrations before exporting.

## How the dialect gap is bridged

- **SQL stays dual-dialect.** Queries in `apps/worker` / `packages/db` are
  written in the SQLite subset that PostgreSQL also accepts. SQLite-only
  syntax was rewritten (`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
  `json_group_array(...)` → JS composition, `char(10)` → bound parameter).
- **SQLite functions are provided as PostgreSQL functions.**
  `packages/db/postgres/compat-functions.sql` defines `strftime`, `julianday`,
  `datetime`, `date`, `json_valid`, `json_each`, `json_extract` with SQLite
  semantics (naive timestamps read as UTC, output rendered as UTC wall-clock,
  modifiers like `'+9 hours'` / `'start of month'`). Schema defaults such as
  `strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')` work unchanged.
- **Timestamps stay TEXT.** Same storage format as D1 (ISO strings, JST by
  default), so string comparisons and existing data keep working. Moving to
  `timestamptz` is a possible later refactor, not part of this migration.
- **Booleans stay INTEGER 0/1**, matching D1; the adapter coerces boolean
  bind parameters to 1/0.
- **Behavior notes:** PostgreSQL `LIKE` is case-sensitive (SQLite's is
  ASCII-case-insensitive). The current `LIKE` usages are exact-case URL
  prefixes and user-content matches where this is acceptable.

## Schema generation

`packages/db/postgres/migrations/0001_init.sql` is generated:

```bash
pnpm --filter @line-crm/db generate:pg-schema
```

reads `packages/db/bootstrap.sql` (the consolidated D1 schema) + the compat
functions, moves FKs to post-create `ALTER TABLE ... DEFERRABLE` statements,
and writes the init migration. Do not edit the generated file by hand.

## Tests

`packages/db/test/pg-adapter.pg.test.ts` runs the adapter against a real
PostgreSQL and is **destructive** (drops the `public` schema). It is skipped
unless `TEST_DATABASE_URL` is set:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5432/linecrm \
  pnpm --filter @line-crm/db test
```

CI (worker-ci.yml) provisions a `postgres:16-alpine` service and runs these
on every PR touching the worker or db packages.
