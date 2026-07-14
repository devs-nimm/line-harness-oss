# Deployment & Redeployment Guide

How to (re)deploy the two runtime pieces of LINE Harness:

| Piece | Where it runs | Cloudflare product | Project / name (default) |
|-------|---------------|--------------------|--------------------------|
| **Admin dashboard** (`apps/web`) | Static export (`output: 'export'` → `apps/web/out`) | **Cloudflare Pages** | `line-harness-admin` |
| **API** (`apps/worker`) | `apps/worker/src/index.ts` | **Cloudflare Workers** | `line-harness` |

The admin dashboard is a static bundle that talks to the Worker over `NEXT_PUBLIC_API_URL`. The Worker owns D1 (database), R2 (images), cron triggers, and all secrets.

There are **three** ways to redeploy. Pick one — they don't need to be mixed.

---

## Authentication: do I need API keys?

Short answer: **it depends on which method you use.**

- **`wrangler login` (OAuth, browser)** — what `npx create-line-harness` used during first-time setup. Those one-or-two browser logins created a local OAuth session on your machine (stored under `~/.config/.wrangler`). Any plain `wrangler ...` command reuses that session. **No API token required.**
- **`CLOUDFLARE_API_TOKEN` (API token)** — required only for **headless / API-based** deploys: the `create-line-harness update` subcommand (it calls the Cloudflare REST API directly, not the local wrangler session) and **GitHub Actions** (a CI runner has no browser to log in with).

So: re-running `wrangler` yourself needs **no keys**. Automating it (CI or the `update` command) needs a token.

To mint a token: Cloudflare dashboard → **My Profile → API Tokens → Create Token**. Permissions needed: `Account · Cloudflare Pages · Edit`, `Account · Workers Scripts · Edit`, `Account · D1 · Edit`, `Account · Workers R2 Storage · Edit`.

---

## Method 1 — `create-line-harness update` (recommended for OSS users)

This is the counterpart to the `npx create-line-harness@latest` you ran to install. It pulls the latest **release bundle**, runs any pending D1 migrations, and redeploys both the Worker and the admin Pages project via the Cloudflare REST API.

```bash
cd <your-line-harness-repo>
CLOUDFLARE_API_TOKEN=<your-token> npx create-line-harness@latest update
```

Why the token here but not during setup? Setup drove `wrangler` interactively with your OAuth login. `update` talks to the Cloudflare API directly and does **not** reuse the OAuth session, so it needs `CLOUDFLARE_API_TOKEN` (supply it via the env var above, or store `cfApiToken` in `.line-harness-config.json`). Account ID and project names are read from `.line-harness-config.json` written at setup.

Use this method when you want the official released version. It does not deploy your local edits.

---

## Method 2 — Manual `wrangler` (deploys your local code, no API keys)

Reuses the `wrangler login` OAuth session from setup. Best when you've edited the code yourself (e.g. the multilingual admin change) and want to ship *your* build.

```bash
# one-time, if the session ever expires:
npx wrangler login

pnpm install
```

### Admin dashboard → Cloudflare Pages

```bash
# Build the workspace packages the admin app imports FIRST. Their compiled
# dist/ is git-ignored, so a fresh checkout has none until you build them —
# skipping this yields "Can't resolve '@line-harness/update-engine/pure'".
pnpm --filter @line-crm/shared build
pnpm --filter @line-harness/update-engine build

NEXT_PUBLIC_API_URL="https://<your-worker-url>" pnpm --filter web build
npx wrangler pages deploy apps/web/out --project-name="line-harness-admin"
```

> `NEXT_PUBLIC_API_URL` is baked in at **build time**, so it must be set for the build step — not just the deploy. Point it at your deployed Worker URL.
>
> Shortcut: `pnpm -r build` builds every workspace package (admin + worker + deps) in one go if you don't want to name them individually.

### API → Cloudflare Workers

```bash
# default (test) environment:
pnpm --filter worker deploy            # == vite build && wrangler deploy

# production environment (see [env.production] in apps/worker/wrangler.toml):
cd apps/worker
npx wrangler deploy --env production --name <your-worker-name>
```

If you changed the D1 schema, apply migrations first:

```bash
npx wrangler d1 execute <your-database> --remote --file=packages/db/schema.sql
```

Secrets (LINE tokens, `API_KEY`) persist across deploys — you only re-set them when they change:

```bash
npx wrangler secret bulk --name <your-worker-name>   # reads JSON from stdin
```

---

## Method 3 — GitHub Actions (automated, requires API token)

The repo ships CI workflows that redeploy on push to `main`:

| Workflow | Redeploys | Triggers on paths |
|----------|-----------|-------------------|
| `.github/workflows/deploy-cloudflare-admin.yml` | Admin → Pages | `apps/web/**`, `packages/shared/**`, root manifest |
| `.github/workflows/deploy-cloudflare-worker.yml` | Worker (+ D1 migrations) | `apps/worker/**` and deps |

Both also support **manual runs** from the GitHub **Actions** tab (`workflow_dispatch`).

Required repo configuration (Settings → Secrets and variables → Actions):

**Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEXT_PUBLIC_API_URL`
**Variables:** `LINE_HARNESS_CLOUDFLARE_DEPLOY=true` (deploy is gated on this), `PAGES_PROJECT_NAME`, `WORKER_NAME`

Once configured, redeploying is just:

```bash
git push origin main
```

---

## Method 4 — Admin dashboard on Vercel (alternative to Cloudflare Pages)

The admin dashboard is a plain Next.js static export, so it can live on Vercel
instead of Cloudflare Pages — typically paired with the self-hosted Docker
backend (`docs/DOCKER.md`) running on a VPS. `apps/web/vercel.json` already
carries the monorepo install/build commands; you only configure the project.

1. **Create the Vercel project** (dashboard → Add New → Project, import the
   repo) and set:
   - **Root Directory**: `apps/web`. The build needs the workspace packages
     outside this directory; Vercel includes them by default ("Include source
     files outside of the Root Directory in the Build Step" — default-on for
     all projects since 2020, only surfaced under Settings → Build and
     Deployment → Root Directory, not in the import screen).
   - **Framework Preset**: Next.js (auto-detected).
   - **Environment variable**: `NEXT_PUBLIC_API_URL` = your backend's public
     HTTPS URL (e.g. `https://api.example.com`), no trailing slash.
2. **Allow the Vercel origin on the backend** (CORS + cross-site cookies). In
   the backend `.env` (docker-compose) or Worker vars:
   ```bash
   ADMIN_ORIGIN=https://your-admin.vercel.app   # comma-separated, no trailing slash
   ADMIN_ALLOW_CROSS_SITE=true                  # admin and API are on different sites
   ```
   Restart the backend (`docker compose up -d`) after changing `.env`.
3. **Deploy.** Vercel's Git integration builds on every push to the production
   branch; nothing is needed in GitHub Actions. The existing Cloudflare Pages
   workflow stays gated behind `LINE_HARNESS_CLOUDFLARE_DEPLOY=true`, so the
   two targets don't conflict.

The API-key / cookie authentication between admin and backend is unchanged —
only the origin allowlist needs the new domain. The LIFF app (`apps/liff`)
still targets Cloudflare Pages; its final home is an open point.

---

## Which method should I use?

- **Just want the latest official release** → Method 1 (`create-line-harness update`).
- **Shipping your own code changes, deploying by hand** → Method 2 (manual wrangler, no keys).
- **Want push-to-deploy automation** → Method 3 (GitHub Actions, one-time token setup).

## Notes

- The admin dashboard is a **static export** — a Pages deploy is just re-uploading a folder. There is no server to restart.
- A **client-only** change (e.g. the admin i18n toggle) needs **only an admin Pages redeploy** — no Worker deploy, no D1 migration.
- A Worker code or schema change needs a **Worker deploy** (and migrations if the schema moved); the admin bundle is unaffected unless you also changed `apps/web`.
