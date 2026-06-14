/**
 * When the optional `@aws-sdk/client-s3` dependency is absent, createS3Store
 * throws a typed S3UnavailableError so callers degrade to local-only instead of
 * 500-ing. Simulated by a mock factory that throws on import.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => {
  throw new Error('Cannot find module @aws-sdk/client-s3');
});

import { createS3Store, S3UnavailableError } from '../../src/framework/s3-store.js';

describe('createS3Store without @aws-sdk/client-s3', () => {
  it('throws S3UnavailableError', async () => {
    await expect(
      createS3Store({ bucket: 'b', region: 'us-east-1', prefix: 'blobs' }),
    ).rejects.toBeInstanceOf(S3UnavailableError);
  });
});
