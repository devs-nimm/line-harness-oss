# Backend image for the self-hosted Docker deployment (MIN-259).
# Runs the Hono app on Node via apps/worker/src/node-server.ts — see
# docs/DOCKER.md for the full setup guide.
#
# Build stage: full install, build the worker's workspace deps + the vite
# client bundle (dist/client, served by the ASSETS shim), then re-install
# production-only so vite/wrangler/test tooling drop out of the final image.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
# ponytail: no lockfile-first layer caching — `pnpm fetch` + offline install
# trips an interactive modules-purge prompt in pnpm 9; a full install per
# image build is the boring reliable path.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter worker... build
RUN pnpm install --frozen-lockfile --prod

# Runtime stage: same source tree — tsx runs the TS sources directly,
# matching how the workspace packages are consumed via `main: src/index.ts`.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

# Apply pending schema migrations (idempotent, recorded in schema_migrations)
# before boot. ponytail: fine while a single backend container runs; move to a
# separate migrate step if this ever scales past one replica.
CMD ["sh", "-c", "node packages/db/scripts/pg-migrate.mjs && exec apps/worker/node_modules/.bin/tsx apps/worker/src/node-server.ts"]
