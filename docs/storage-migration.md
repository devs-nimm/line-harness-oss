# Storage migration: Cloudflare R2 → MinIO (S3-compatible)

MIN-258 replaces the R2 `IMAGES` binding with a portable S3 client
(`apps/worker/src/lib/storage.ts`). The worker now talks to any S3-compatible
store via `S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY`. Default
backend is self-hosted **MinIO** (`docker-compose.yml`); switching to AWS S3 or
another provider is an env-var change, no code change.

Object keys and public URLs are unchanged — images keep being served through the
worker routes (`GET /images/:key`, `GET /api/rich-menu-images/:key`), so no
client or DB change is needed. Only the storage backend moves.

## 1. Start MinIO

```bash
docker compose up -d minio minio-init   # creates the bucket on first boot
```

Console: http://localhost:9001 (root user/pass = `S3_ACCESS_KEY`/`S3_SECRET_KEY`).

## 2. Configure the worker

Local: copy `.env.example` values. Deployed worker:

```bash
# non-secret config is in wrangler.toml [vars]; set the keys as secrets:
wrangler secret put S3_ACCESS_KEY
wrangler secret put S3_SECRET_KEY
```

Point `S3_ENDPOINT` at your MinIO (or AWS S3) endpoint. Use
`S3_FORCE_PATH_STYLE=true` for MinIO, `false` for AWS S3 virtual-host style.

## 3. One-off copy of existing R2 objects (rclone)

`rclone` copies R2 → MinIO directly, preserving keys and content-types.

```bash
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id     = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET_ACCESS_KEY>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com

[minio]
type = s3
provider = Minio
access_key_id     = <S3_ACCESS_KEY>
secret_access_key = <S3_SECRET_KEY>
endpoint = http://localhost:9000
```

```bash
# dry run first, then copy, then verify counts match
rclone copy r2:line-harness-images minio:line-harness-images --dry-run
rclone copy r2:line-harness-images minio:line-harness-images --progress
rclone check r2:line-harness-images minio:line-harness-images
```

Cut over by pointing `S3_ENDPOINT` at MinIO and redeploying. Keep the R2 bucket
until you've confirmed images serve correctly, then decommission it.

## 4. Durability

A single-VPS MinIO volume is only as durable as the VPS disk. Include the
`minio-data` volume in the same backup routine as Postgres (snapshot the volume
or `rclone sync minio:line-harness-images <offsite>` on a schedule).
