import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the S3 client so no network is touched; capture the last command sent.
const send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send = send;
    },
    PutObjectCommand: class extends Cmd {},
    GetObjectCommand: class extends Cmd {},
    DeleteObjectCommand: class extends Cmd {},
    ListObjectsV2Command: class extends Cmd {},
  };
});

const { getImageStore } = await import('./storage.js');

const S3_ENV = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'images',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => send.mockReset());

describe('getImageStore', () => {
  test('injection seam: returns env.IMAGES verbatim without touching S3', () => {
    const fake = { put: vi.fn(), get: vi.fn(), delete: vi.fn(), list: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getImageStore({ IMAGES: fake } as any)).toBe(fake);
    expect(send).not.toHaveBeenCalled();
  });

  test('constructing a store never throws; the S3-config guard fires on first op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = getImageStore({} as any); // must not throw (e.g. text webhooks never touch it)
    await expect(store.get('k')).rejects.toThrow(/S3 storage not configured/);
  });

  test('put maps httpMetadata.contentType → ContentType and buffers ArrayBuffer', async () => {
    send.mockResolvedValue({});
    await getImageStore(S3_ENV).put('k.png', new ArrayBuffer(4), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { originalFilename: 'a.png' },
    });
    const { input } = send.mock.calls[0][0];
    expect(input).toMatchObject({
      Bucket: 'images',
      Key: 'k.png',
      ContentType: 'image/png',
      Metadata: { originalFilename: 'a.png' },
    });
    expect(input.Body).toBeInstanceOf(Uint8Array);
  });

  test('get strips surrounding quotes from ETag and returns R2-shaped object', async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2]) },
      ContentType: 'image/jpeg',
      ETag: '"abc123"',
    });
    const obj = await getImageStore(S3_ENV).get('k.jpg');
    expect(obj).toEqual({
      body: new Uint8Array([1, 2]),
      httpMetadata: { contentType: 'image/jpeg' },
      etag: 'abc123',
    });
  });

  test('get returns null on NoSuchKey / 404', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    expect(await getImageStore(S3_ENV).get('nope')).toBeNull();

    send.mockRejectedValueOnce(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } }));
    expect(await getImageStore(S3_ENV).get('nope')).toBeNull();
  });

  test('get rethrows non-404 errors', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'InternalError' }));
    await expect(getImageStore(S3_ENV).get('k')).rejects.toThrow('boom');
  });

  test('list paginates via ContinuationToken and flattens keys', async () => {
    send
      .mockResolvedValueOnce({ Contents: [{ Key: 'a' }, { Key: 'b' }], IsTruncated: true, NextContinuationToken: 't1' })
      .mockResolvedValueOnce({ Contents: [{ Key: 'c' }], IsTruncated: false });
    expect(await getImageStore(S3_ENV).list('rich-menus/')).toEqual(['a', 'b', 'c']);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
