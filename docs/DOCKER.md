# Self-hosted Docker deployment (VPS)

As of MIN-259 the backend runs as a Node.js process in Docker instead of a
Cloudflare Worker. One `docker-compose.yml` provides the full stack:

| Service    | What                                            | Port (host)            |
| ---------- | ----------------------------------------------- | ---------------------- |
| `backend`  | Hono app on Node (`apps/worker`), API + SPA     | `${BACKEND_PORT:-8787}`|
| `postgres` | PostgreSQL 16 (replaces D1, see `POSTGRES.md`)  | `${POSTGRES_PORT:-5432}` |
| `minio`    | S3-compatible object storage (replaces R2)      | 9000 / console 9001    |

## Quickstart

```bash
cp .env.example .env
# Required edits in .env:
#   POSTGRES_PASSWORD           strong password (also used in DATABASE_URL)
#   API_KEY                     admin/API key
#   LINE_CHANNEL_ACCESS_TOKEN   from LINE Developers console
#   LINE_CHANNEL_SECRET         from LINE Developers console
#   S3_ACCESS_KEY / S3_SECRET_KEY   change from minioadmin defaults
#   WORKER_URL                  public HTTPS URL of the backend (see TLS below)

docker compose up -d --build
curl http://localhost:8787/api/health
# → {"success":true,"data":{"status":"ok"}}
```

The backend container applies pending schema migrations on every boot
(idempotent — `packages/db/scripts/pg-migrate.mjs`, recorded in
`schema_migrations`), so a fresh install needs no manual migration step.

Notes:

- `env_file: .env` passes everything to the container; docker-compose
  overrides `DATABASE_URL` and `S3_ENDPOINT` with in-network hostnames
  (`postgres`, `minio`), so the localhost values in `.env` only matter when
  running the backend on the host (`pnpm --filter worker start:node`).
- If `POSTGRES_PASSWORD` contains URL-special characters (`@ / : %`), they
  must be percent-encoded wherever a `DATABASE_URL` is written by hand.
- Cron jobs (step delivery, broadcasts, reminders — the former Workers cron
  triggers) run in-process on a 5-minute wall-clock schedule; the 6-hourly
  expirers ride the matching tick. No extra container needed.

## TLS reverse proxy (required for LINE webhooks)

LINE only delivers webhooks to valid HTTPS endpoints, so put a reverse proxy
with a real certificate in front of the backend. Caddy is the least-effort
option (automatic Let's Encrypt):

```
# /etc/caddy/Caddyfile
line.example.com {
    reverse_proxy localhost:8787
}
```

nginx equivalent: a standard `proxy_pass http://127.0.0.1:8787;` server block
plus certbot. Either way:

1. Point DNS `line.example.com` → your VPS.
2. Set `WORKER_URL=https://line.example.com` in `.env` and
   `docker compose up -d` again.
3. In the LINE Developers console (Messaging API → Webhook settings), set the
   webhook URL to `https://line.example.com/webhook` and verify.

The admin SPA is served by the backend itself at `https://line.example.com/`
(same origin as the API — no CORS/cross-site cookie setup needed).

## Migrating an existing Cloudflare install

1. **Database**: export D1 and import into Postgres — see
   `docs/POSTGRES.md` ("Migrating data from an existing D1 install").
2. **Images**: copy R2 objects into MinIO with rclone — see
   `docs/storage-migration.md`.
3. **Webhook**: switch the webhook URL in the LINE console to the new domain
   (step 3 above). Do this last; delivery cuts over instantly.

## Updates

The Phase 5 self-update feature (`/admin/update/*`) is Cloudflare-specific
(it drives the Cloudflare API) and is inert on Docker — its `CF_API_TOKEN` /
`ADMIN_API_KEY` vars are simply never set, and the routes runtime-guard on
their absence. To update a Docker install:

```bash
git pull
docker compose up -d --build
```

Migrations apply automatically on boot.

## Backups

The named volumes `pgdata` and `minio-data` are the only state. Back them up
together, e.g. nightly:

```bash
docker compose exec postgres pg_dump -U postgres linecrm | gzip > backup.sql.gz
# plus a filesystem-level copy/rclone sync of the minio-data volume
```
