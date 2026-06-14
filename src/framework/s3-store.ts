/**
 * S3 object storage for file blobs (cloud workspaces). Bytes uploaded to a cloud
 * are written to S3 under a content-addressed key so every member who can see the
 * `files` row can pull them down — see `docs/cloud.md`. `@aws-sdk/client-s3` is an
 * OPTIONAL dependency, lazy-imported the same way `sharp` is, so a build without it
 * still loads: callers catch {@link S3UnavailableError} and fall back to local-only
 * blobs rather than failing.
 *
 * Access control is NOT enforced here — it rides entirely on the `files`-row
 * Postgres RLS at the serve route (`files-routes.ts`): a member only ever learns a
 * key for a row they can SELECT, keys are unguessable (sha256), and the bucket
 * credential is least-privilege (GetObject/PutObject only, no ListBucket). See the
 * security notes in `docs/cloud.md`.
 */

/** A minimal remote blob store — the only surface the upload + serve paths use. */
export interface RemoteBlobStore {
  /** Idempotent upload under `key` (same content ⇒ same key ⇒ same object). */
  put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void>;
  /** Stream the object's bytes back (to pipe into an HTTP response). */
  get(key: string): Promise<NodeJS.ReadableStream>;
  /** Whether an object exists under `key`. */
  exists(key: string): Promise<boolean>;
}

/** Connection config for an S3 (or S3-compatible) bucket. Credentials are optional
 *  — when omitted, the AWS default credential chain (env / shared config / IAM
 *  role) is used. `endpoint` (+ path-style) targets R2 / MinIO / LocalStack. */
export interface S3StoreConfig {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** Thrown when `@aws-sdk/client-s3` is not installed. Callers degrade to
 *  local-only behavior; they do not 500. */
export class S3UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3UnavailableError';
  }
}

/** Content-addressed object key: `<prefix>/<sha256>` (POSIX separators, stable
 *  across machines + idempotent). A leading/trailing slash on the prefix is
 *  normalized away. */
export function s3Key(prefix: string, sha256: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${sha256}` : sha256;
}

/**
 * Build a {@link RemoteBlobStore} backed by S3. Throws {@link S3UnavailableError}
 * if the optional `@aws-sdk/client-s3` dependency is absent — the lazy import
 * mirrors the `sharp` pattern so the module loads without it.
 */
export async function createS3Store(cfg: S3StoreConfig): Promise<RemoteBlobStore> {
  let mod: typeof import('@aws-sdk/client-s3');
  try {
    mod = await import('@aws-sdk/client-s3');
  } catch {
    throw new S3UnavailableError(
      'S3 file storage requires the optional "@aws-sdk/client-s3" dependency, which is not installed',
    );
  }
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = mod;
  const client = new S3Client({
    region: cfg.region,
    // forcePathStyle is required for S3-compatible endpoints (R2 / MinIO /
    // LocalStack) which don't support virtual-hosted-style bucket subdomains.
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.credentials ? { credentials: cfg.credentials } : {}),
  });

  return {
    async put(key, body, opts) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        }),
      );
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      const body = out.Body;
      if (!body) throw new Error(`S3: object "${key}" has no body`);
      // In Node the SDK returns a Readable stream; pipe it straight to the response.
      return body as unknown as NodeJS.ReadableStream;
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
        throw e;
      }
    },
  };
}
