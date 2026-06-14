/**
 * S3 blob store — round-trips bytes through a mocked `@aws-sdk/client-s3`
 * (lazy-imported, so the mock intercepts cleanly) and proves content-addressed
 * keying. The "@aws-sdk absent → S3UnavailableError" path is covered separately
 * in s3-store-unavailable.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const { bucketState } = vi.hoisted(() => ({ bucketState: new Map<string, Buffer>() }));

vi.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    constructor(public input: { Key: string; Body: Buffer }) {}
  }
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class HeadObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class S3Client {
    constructor(public cfg: unknown) {}
    send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof PutObjectCommand) {
        bucketState.set(cmd.input.Key, cmd.input.Body);
        return Promise.resolve({});
      }
      if (cmd instanceof HeadObjectCommand) {
        if (bucketState.has(cmd.input.Key)) return Promise.resolve({});
        const e = Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return Promise.reject(e);
      }
      if (cmd instanceof GetObjectCommand) {
        const buf = bucketState.get(cmd.input.Key);
        if (!buf) {
          const e = Object.assign(new Error('NoSuchKey'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
          return Promise.reject(e);
        }
        return Promise.resolve({ Body: Readable.from(buf) });
      }
      return Promise.reject(new Error('unknown command'));
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand };
});

import { createS3Store, s3Key } from '../../src/framework/s3-store.js';

const cfg = { bucket: 'b', region: 'us-east-1', prefix: 'blobs' };

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

beforeEach(() => {
  bucketState.clear();
});

describe('s3Key', () => {
  it('is content-addressed `<prefix>/<sha256>` and normalizes slashes', () => {
    expect(s3Key('blobs', 'abc')).toBe('blobs/abc');
    expect(s3Key('/p/q/', 'abc')).toBe('p/q/abc');
    expect(s3Key('', 'abc')).toBe('abc');
  });
});

describe('createS3Store', () => {
  it('put → exists → get round-trips the bytes', async () => {
    const store = await createS3Store(cfg);
    const key = s3Key(cfg.prefix, 'deadbeef');
    expect(await store.exists(key)).toBe(false);
    await store.put(key, Buffer.from('hello s3'), { contentType: 'text/plain' });
    expect(await store.exists(key)).toBe(true);
    expect((await drain(await store.get(key))).toString()).toBe('hello s3');
  });

  it('exists is false for a missing key (not an error)', async () => {
    const store = await createS3Store(cfg);
    expect(await store.exists('blobs/nope')).toBe(false);
  });

  it('get throws for a missing key', async () => {
    const store = await createS3Store(cfg);
    await expect(store.get('blobs/nope')).rejects.toThrow();
  });
});
