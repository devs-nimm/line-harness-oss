/**
 * Node.js entry point for the self-hosted Docker deployment (MIN-259).
 *
 * The Hono app in ./index.ts is runtime-portable; this file provides the
 * pieces Cloudflare Workers used to inject:
 *
 * - `DB` binding      → createPgD1Database over DATABASE_URL (MIN-257 adapter)
 * - `ASSETS` binding  → static file server over the vite-built dist/client,
 *                       with SPA index.html fallback (replaces the Workers
 *                       assets directive; run_worker_first semantics hold
 *                       automatically because every request goes through the
 *                       app first, so the bot-UA → OGP branch keeps working)
 * - executionCtx      → waitUntil shim: fire the promise, log rejections.
 *                       The process is long-lived so nothing must be kept
 *                       alive; this only preserves error visibility.
 * - cron triggers     → wall-clock-aligned 5-minute scheduler calling the
 *                       same scheduled() handler. Ticks at minute 0 of hours
 *                       0/6/12/18 UTC are labeled with the 6h cron so the
 *                       expirers run, matching the Workers [triggers] config.
 *
 * Everything else (secrets, S3_* storage config, LINE credentials) is read
 * straight from process.env — docker-compose feeds it from .env.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { createPgD1Database } from '@line-crm/db/src/pg/adapter.js';
import worker from './index.js';
import type { Env } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (postgres://user:pass@host:5432/db)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ASSETS binding shim — serve the vite-built SPA from dist/client
// ---------------------------------------------------------------------------

const CLIENT_DIR = resolve(
  process.env.CLIENT_DIST_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client'),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveFile(path: string, cacheControl: string): Promise<Response | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    // node:stream/web vs workers-types ReadableStream declaration mismatch.
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(info.size),
        'Cache-Control': cacheControl,
      },
    });
  } catch {
    return null;
  }
}

const assets = {
  async fetch(req: Request): Promise<Response> {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    const filePath = resolve(join(CLIENT_DIR, pathname));
    // Path traversal guard: never serve outside dist/client.
    if (filePath === CLIENT_DIR || filePath.startsWith(CLIENT_DIR + sep)) {
      // Vite emits content-hashed filenames under /assets/ → cache forever.
      const cacheControl = pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      const file = await serveFile(filePath, cacheControl);
      if (file) return file;
    }
    // SPA fallback (same behavior as the Workers assets directive's
    // single-page-application handling).
    const index = await serveFile(join(CLIENT_DIR, 'index.html'), 'no-cache');
    return index ?? new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Bindings + execution context
// ---------------------------------------------------------------------------

const env = {
  ...process.env,
  DB: createPgD1Database(DATABASE_URL),
  ASSETS: assets,
} as unknown as Env['Bindings'];

const executionCtx = {
  // On Workers waitUntil keeps the isolate alive; a Node process is already
  // long-lived, so only rejection logging remains.
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch((err) => console.error('[waitUntil]', err));
  },
  passThroughOnException(): void {},
  props: {},
};

// ---------------------------------------------------------------------------
// Cron scheduler — replaces wrangler.toml [triggers] crons
// ---------------------------------------------------------------------------

const FIVE_MINUTES = 5 * 60_000;

async function runScheduled(): Promise<void> {
  const now = new Date();
  // Minute-0 tick of hours 0/6/12/18 UTC carries the 6h cron label so the
  // booking/event expirers run (scheduled() switches on event.cron).
  const cron =
    now.getUTCMinutes() === 0 && now.getUTCHours() % 6 === 0 ? '0 */6 * * *' : '*/5 * * * *';
  try {
    await worker.scheduled(
      { cron, scheduledTime: now.getTime(), noRetry() {} } as ScheduledEvent,
      env,
      executionCtx as ExecutionContext,
    );
  } catch (err) {
    console.error('[cron] scheduled() failed:', err);
  }
}

let cronTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleNextTick(): void {
  // Align to wall-clock 5-minute boundaries; the next tick is armed only
  // after the previous run finishes, so runs never overlap. A run longer
  // than 5 minutes simply skips to the next boundary.
  const delay = FIVE_MINUTES - (Date.now() % FIVE_MINUTES);
  cronTimer = setTimeout(() => {
    void runScheduled().finally(scheduleNextTick);
  }, delay);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
const server = serve(
  {
    fetch: (req) => worker.fetch(req, env, executionCtx as ExecutionContext),
    port,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`line-harness backend listening on :${info.port} (assets: ${CLIENT_DIR})`);
  },
);
scheduleNextTick();

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  if (cronTimer) clearTimeout(cronTimer);
  server.close(() => process.exit(0));
  // In-flight cron work has no cancellation seam; give it a grace period.
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
