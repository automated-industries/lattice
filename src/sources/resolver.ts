import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFetch } from './url-safety.js';
import {
  ReferenceUnavailableError,
  type FilesRow,
  type RefKind,
  type RefProvider,
  type ResolveOptions,
  type SourceHandle,
  type SourceMetadata,
} from './types.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Resolve a `files` row to a {@link SourceHandle}. Dispatches on `ref_kind`
 * (NULL ⇒ owned blob, for back-compat). Every caller reads bytes/metadata the
 * same way regardless of whether the source is local or cloud.
 */
export function resolveSource(
  row: FilesRow,
  latticeRoot: string,
  opts: ResolveOptions = {},
): SourceHandle {
  switch (refKindOf(row)) {
    case 'local_ref':
      return fsHandle(row);
    case 'cloud_ref':
      return row.ref_provider === 's3' ? s3Handle(row, latticeRoot) : urlHandle(row, opts);
    default:
      return blobHandle(row, latticeRoot);
  }
}

function refKindOf(row: FilesRow): RefKind {
  if (row.ref_kind === 'local_ref' || row.ref_kind === 'cloud_ref') return row.ref_kind;
  return 'blob';
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function blobHandle(row: FilesRow, latticeRoot: string): SourceHandle {
  const rel = row.blob_path ?? null;
  const abs = rel ? join(latticeRoot, rel) : null;
  const location = rel ? `blob:${rel}` : 'blob:?';
  return {
    kind: 'blob',
    provider: 'fs',
    location,
    async readContent(): Promise<Buffer> {
      if (!abs) throw new ReferenceUnavailableError(location, 'row has no blob_path');
      try {
        return await readFile(abs);
      } catch (e) {
        throw new ReferenceUnavailableError(location, (e as Error).message);
      }
    },
    async getMetadata(): Promise<SourceMetadata> {
      if (!abs) return meta(false);
      return statMeta(abs, row);
    },
  };
}

function fsHandle(row: FilesRow): SourceHandle {
  const path = row.ref_uri ?? '';
  return {
    kind: 'local_ref',
    provider: 'fs',
    location: path,
    async readContent(): Promise<Buffer> {
      try {
        return await readFile(path);
      } catch (e) {
        throw new ReferenceUnavailableError(path, (e as Error).message);
      }
    },
    async getMetadata(): Promise<SourceMetadata> {
      return statMeta(path, row);
    },
  };
}

function s3Handle(row: FilesRow, latticeRoot: string): SourceHandle {
  // An S3-backed cloud blob. If the uploader's local copy is still here (hybrid),
  // read it directly. Otherwise this generic resolver can't fetch the bytes — S3
  // access needs the workspace's S3 config + the files-row RLS gate, which live
  // in the files-serve route — so report unavailable rather than mis-fetching the
  // `s3://` URL over HTTP.
  if (row.blob_path) return blobHandle(row, latticeRoot);
  const loc = row.ref_uri ?? 's3:?';
  return {
    kind: 'cloud_ref',
    provider: 's3',
    location: loc,
    readContent(): Promise<Buffer> {
      return Promise.reject(
        new ReferenceUnavailableError(
          loc,
          'S3-backed blob: fetch through the files API (GET /api/files/:id/blob), not the generic resolver',
        ),
      );
    },
    getMetadata(): Promise<SourceMetadata> {
      return Promise.resolve(meta(false, { extra: { provider: 's3' } }));
    },
  };
}

function urlHandle(row: FilesRow, opts: ResolveOptions): SourceHandle {
  const url = row.ref_uri ?? '';
  const provider: RefProvider = row.ref_provider === 'gdrive' ? 'gdrive' : 'web';
  const fetchImpl = opts.fetcher ?? fetch;
  const allowPrivate = opts.allowPrivate ?? false;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    kind: 'cloud_ref',
    provider,
    location: url,
    async readContent(): Promise<Buffer> {
      let res: Response;
      try {
        res = await safeFetch(url, fetchImpl, { allowPrivate });
      } catch (e) {
        throw new ReferenceUnavailableError(url, (e as Error).message);
      }
      if (!res.ok) throw new ReferenceUnavailableError(url, `HTTP ${String(res.status)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    },
    async getMetadata(): Promise<SourceMetadata> {
      try {
        const res = await safeFetch(url, fetchImpl, { allowPrivate, init: { method: 'HEAD' } });
        if (!res.ok) return meta(false, { extra: { http_status: res.status } });
        const len = res.headers.get('content-length');
        return meta(true, {
          mime: res.headers.get('content-type'),
          size_bytes: len ? Number(len) : null,
        });
      } catch (e) {
        return meta(false, { extra: { error: (e as Error).message } });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata helpers (exactOptionalPropertyTypes-safe construction)
// ---------------------------------------------------------------------------

interface MetaParts {
  size_bytes?: number | null;
  mime?: string | null;
  original_name?: string | null;
  modified_at?: string | null;
  extra?: Record<string, unknown>;
}

function meta(available: boolean, parts: MetaParts = {}): SourceMetadata {
  const m: SourceMetadata = { available };
  if (parts.size_bytes != null) m.size_bytes = parts.size_bytes;
  if (parts.mime != null) m.mime = parts.mime;
  if (parts.original_name != null) m.original_name = parts.original_name;
  if (parts.modified_at != null) m.modified_at = parts.modified_at;
  if (parts.extra != null) m.extra = parts.extra;
  return m;
}

async function statMeta(path: string, row: FilesRow): Promise<SourceMetadata> {
  try {
    const s = await stat(path);
    return meta(true, {
      size_bytes: s.size,
      modified_at: s.mtime.toISOString(),
      original_name: row.original_name ?? null,
      mime: row.mime ?? null,
    });
  } catch {
    return meta(false);
  }
}
