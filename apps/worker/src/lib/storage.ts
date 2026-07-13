// S3-compatible object storage (MIN-258).
//
// Replaces the Cloudflare R2 `IMAGES` binding with a portable S3 client so the
// deployment is not locked to Cloudflare. Default backend is self-hosted MinIO
// (docker-compose); switching to AWS S3 or any S3-compatible provider is an
// env-var change (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY), no code
// change. The returned objects mirror the small subset of the R2 API the
// callers used (put / get / delete / list) so existing call sites are untouched
// beyond swapping `c.env.IMAGES` → `getImageStore(c.env)`.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

/** R2-shaped object so existing consumers keep working after the swap. */
export interface StoredObject {
  body: Uint8Array;
  httpMetadata: { contentType?: string };
  etag: string;
}

export interface PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface ImageStore {
  put(key: string, data: ArrayBuffer | Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// ponytail: one client per isolate — env is constant across a deployment, so a
// single module-level client is safe. Rebuild only if it was never built.
let cached: { client: S3Client; bucket: string } | null = null;

function s3(env: Bindings): { client: S3Client; bucket: string } {
  if (cached) return cached;
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new Error(
      'S3 storage not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY',
    );
  }
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION || 'auto',
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    // MinIO and most self-hosted S3 need path-style addressing (bucket in path,
    // not subdomain). Opt out with S3_FORCE_PATH_STYLE=false for AWS S3 vhost.
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  });
  cached = { client, bucket: S3_BUCKET };
  return cached;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Resolve the image store for a request. `env.IMAGES` acts as an injection seam
 * (tests / legacy binding pass a fake store); otherwise the S3-backed store is
 * built lazily from the S3_* env vars.
 */
export function getImageStore(env: Bindings): ImageStore {
  if (env.IMAGES) return env.IMAGES;

  // Client is built lazily on first use so constructing the store never throws
  // — callers that receive a store but never touch it (e.g. text-message
  // webhooks) must not trip the "S3 not configured" guard.
  return {
    async put(key, data, opts) {
      const { client, bucket } = s3(env);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: toBytes(data),
          ContentType: opts?.httpMetadata?.contentType,
          Metadata: opts?.customMetadata,
        }),
      );
    },

    async get(key) {
      const { client, bucket } = s3(env);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        // images are ≤10MB (validated at upload); buffering the whole object
        // avoids Node/web stream-type mismatches across the aws-sdk runtimes.
        // ponytail: buffer full object; stream via res.Body if large files land.
        const body = res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
        return {
          body,
          httpMetadata: { contentType: res.ContentType },
          etag: (res.ETag ?? '').replace(/^"|"$/g, ''),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async delete(key) {
      const { client, bucket } = s3(env);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async list(prefix) {
      const { client, bucket } = s3(env);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
