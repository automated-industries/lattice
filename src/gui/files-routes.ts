import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Lattice } from '../lattice.js';
import { sendJson } from './http.js';
import { createS3Store } from '../framework/s3-store.js';
import { resolveActiveS3Config } from '../framework/s3-config.js';

/**
 * Serving + OS integration for ingested files. A `files` row points at a local
 * file — either the legacy `path` column (DEPRECATED) or a v2.0 `local_ref`
 * (`ref_uri`); ingest references files, it does not copy bytes — so the blob is
 * streamed straight from disk for inline preview, and "open in Finder" shells
 * the platform opener — gated behind LATTICE_LOCAL_OPEN since it only makes
 * sense when the GUI server shares the user's machine.
 *
 * Localhost trust, like the other GUI routes.
 */

interface FilesContext {
  db: Lattice;
  /** Workspace root (holds `data/blobs/`), to resolve `blob_path` references. */
  latticeRoot?: string;
  /** Active config path, to resolve the workspace's S3 settings (a cloud file's
   *  bytes may live in S3 rather than on this member's disk). */
  configPath?: string;
  pathname: string;
  method: string;
}

interface FileRow {
  path?: string | null;
  ref_kind?: string | null;
  ref_uri?: string | null;
  ref_provider?: string | null;
  source_json?: string | null;
  blob_path?: string | null;
  mime?: string | null;
  original_name?: string | null;
  deleted_at?: string | null;
}

/**
 * The local filesystem path a row points at, for the two storage modes this
 * route can stream: a legacy `path` (DEPRECATED) or a v2.0 `local_ref`
 * (`ref_uri`). Cloud references (`ref_uri` holds a URL) and owned blobs are not
 * served from here, so they resolve to null.
 */
function localPathOf(row: FileRow, latticeRoot?: string): string | null {
  if (typeof row.path === 'string' && row.path) return row.path;
  if (row.ref_kind === 'local_ref' && typeof row.ref_uri === 'string' && row.ref_uri) {
    return row.ref_uri;
  }
  // A content-addressed blob under the workspace's data/blobs/. Resolved for both
  // a local-only 'blob' row AND a 'cloud_ref' row that still has a local copy
  // (the uploader's hybrid fast path) — the caller stat-checks it and falls back
  // to S3 when the file isn't on this member's disk.
  if (
    (row.ref_kind === 'blob' || row.ref_kind === 'cloud_ref') &&
    typeof row.blob_path === 'string' &&
    row.blob_path
  ) {
    return isAbsolute(row.blob_path)
      ? row.blob_path
      : latticeRoot
        ? join(latticeRoot, row.blob_path)
        : null;
  }
  return null;
}

/** The S3 object `{ bucket, key }` a row points at, or null. Prefers `source_json`
 *  (where the upload recorded it), falling back to parsing the `s3://bucket/key`
 *  `ref_uri`. */
function s3RefOf(row: FileRow): { bucket: string; key: string } | null {
  if (row.ref_kind !== 'cloud_ref' || row.ref_provider !== 's3') return null;
  if (typeof row.source_json === 'string' && row.source_json) {
    try {
      const j = JSON.parse(row.source_json) as { bucket?: unknown; key?: unknown };
      if (typeof j.bucket === 'string' && typeof j.key === 'string') {
        return { bucket: j.bucket, key: j.key };
      }
    } catch {
      // fall through to ref_uri
    }
  }
  if (typeof row.ref_uri === 'string') {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(row.ref_uri);
    if (m) return { bucket: m[1] ?? '', key: m[2] ?? '' };
  }
  return null;
}

/** Whether a resolved local path is a readable regular file on THIS machine. */
function localFileExists(loc: string | null): loc is string {
  if (!loc) return false;
  try {
    return statSync(loc).isFile();
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '_');
}

const BLOB_RE = /^\/api\/files\/([^/]+)\/blob$/;
const OPEN_RE = /^\/api\/files\/([^/]+)\/open-in-finder$/;

export async function dispatchFilesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: FilesContext,
): Promise<boolean> {
  const blobMatch = BLOB_RE.exec(ctx.pathname);
  if (blobMatch && ctx.method === 'GET') {
    const id = decodeURIComponent(blobMatch[1] ?? '');
    // RLS gate: on a cloud this get() runs as the member's scoped role, so a row
    // they can't see returns null → 404. S3 access rides entirely on this — there
    // is no separate byte-level check.
    const row = (await ctx.db.get('files', id)) as FileRow | null;
    if (!row || row.deleted_at) {
      sendJson(res, { error: 'file not found' }, 404);
      return true;
    }
    const name = sanitizeFilename(row.original_name ?? 'file');
    const contentType =
      typeof row.mime === 'string' && row.mime ? row.mime : 'application/octet-stream';

    // Prefer a local copy when this member has the bytes (the uploader, or a
    // legacy local-only blob) — instant, no S3 round-trip.
    const loc = localPathOf(row, ctx.latticeRoot);
    if (localFileExists(loc)) {
      res.writeHead(200, {
        'content-type': contentType,
        'content-disposition': `inline; filename="${name}"`,
        'cache-control': 'no-store',
      });
      const stream = createReadStream(loc);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return true;
    }

    // No local bytes — if this is an S3-backed file, stream it from S3 using the
    // workspace's S3 config. (The RLS gate above already authorized the read.)
    const s3 = s3RefOf(row);
    const s3cfg = s3 ? resolveActiveS3Config(ctx.configPath) : null;
    if (s3 && s3cfg) {
      try {
        const store = await createS3Store(s3cfg);
        const stream = await store.get(s3.key);
        res.writeHead(200, {
          'content-type': contentType,
          'content-disposition': `inline; filename="${name}"`,
          'cache-control': 'no-store',
        });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } catch (e) {
        sendJson(res, { error: `file bytes unavailable from S3: ${(e as Error).message}` }, 502);
      }
      return true;
    }

    sendJson(
      res,
      { error: 'this file has no underlying blob here (text-only ingest, or S3 not configured)' },
      404,
    );
    return true;
  }

  const openMatch = OPEN_RE.exec(ctx.pathname);
  if (openMatch && ctx.method === 'POST') {
    if (process.env.LATTICE_LOCAL_OPEN !== '1') {
      sendJson(res, { enabled: false });
      return true;
    }
    const id = decodeURIComponent(openMatch[1] ?? '');
    const row = (await ctx.db.get('files', id)) as FileRow | null;
    const loc = row ? localPathOf(row, ctx.latticeRoot) : null;
    if (!loc) {
      sendJson(res, { error: 'file has no local path' }, 404);
      return true;
    }
    const opener =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer'
          : 'xdg-open';
    try {
      const child = spawn(opener, [loc], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        /* surfaced below via the catch on spawn throw; nothing to stream */
      });
      child.unref();
      sendJson(res, { enabled: true, opened: true });
    } catch (e) {
      sendJson(res, { enabled: true, opened: false, error: (e as Error).message }, 500);
    }
    return true;
  }

  return false;
}
