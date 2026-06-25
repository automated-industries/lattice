import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Lattice } from '../lattice.js';
import { sendJson } from './http.js';
import { createS3Store } from '../framework/s3-store.js';
import { resolveActiveS3Config } from '../framework/s3-config.js';

/**
 * Serving + OS integration for ingested files. A `files` row points at a local
 * file via a `local_ref` (`ref_uri`); ingest references files, it does not copy
 * bytes — so the blob is
 * streamed straight from disk for inline preview, and "open in Finder" shells
 * the platform opener — gated behind LATTICE_LOCAL_OPEN since it only makes
 * sense when the GUI server shares the user's machine.
 *
 * Localhost trust, like the other GUI routes.
 */

/**
 * Whether the GUI may shell the platform "open in Finder/Explorer" for a local
 * file. Defaults ON (a `lattice gui` is a local desktop tool sharing the user's
 * machine); set `LATTICE_LOCAL_OPEN=0` to disable, in which case the GUI hides the
 * "Open in Finder" affordance entirely rather than offering a dead button.
 */
export function localFileOpenEnabled(): boolean {
  return process.env.LATTICE_LOCAL_OPEN !== '0';
}

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
 * The local filesystem path a row points at, for the storage modes this route
 * can stream: a `local_ref` (`ref_uri`) or a content-addressed blob/cloud_ref
 * whose bytes are still on this disk (`blob_path`). Cloud references (`ref_uri`
 * holds a URL) and remote-only blobs are not served from here, so they resolve
 * to null.
 */
function localPathOf(row: FileRow, latticeRoot?: string): string | null {
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

/** A recognizable file extension for common mime types, used to name a blob
 *  copy when revealing it (a content-addressed blob is stored extensionless). */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};

/**
 * The on-disk path to REVEAL in the OS file browser for a files row. A row backed
 * by a named local original (a `local_ref` `ref_uri`) is revealed
 * as-is. But a content-addressed blob is stored at `data/blobs/<sha256>` — no name,
 * no extension — so revealing it shows a hash-named generic "Document" instead of
 * the user's image. For a blob we therefore materialize a named copy at
 * `data/finder/<id>/<original_name>` (adding an extension from the mime if missing)
 * and reveal THAT, so the user sees their actual "Screenshot ….png". `loc` is the
 * already-resolved {@link localPathOf}; `id` the row's primary key. Best-effort:
 * any copy failure falls back to revealing `loc` so the action still does something.
 */
export function revealTargetFor(
  row: FileRow,
  latticeRoot: string | undefined,
  loc: string,
  id: string,
): string {
  const isNamedOriginal = row.ref_kind === 'local_ref';
  if (isNamedOriginal) return loc; // already a real, named file
  if (!latticeRoot) return loc;
  let name = sanitizeFilename(row.original_name ?? 'file');
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const ext = typeof row.mime === 'string' ? MIME_EXT[row.mime] : undefined;
    if (ext) name += ext;
  }
  const dir = join(latticeRoot, 'data', 'finder', id.replace(/[^A-Za-z0-9_-]/g, '_'));
  const named = join(dir, name);
  try {
    // Re-export only when missing or stale (size differs) — idempotent re-reveal.
    const fresh = existsSync(named) && statSync(named).size === statSync(loc).size;
    if (!fresh) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(loc, named);
    }
    return named;
  } catch {
    return loc; // reveal the blob rather than nothing
  }
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

/**
 * Response headers for serving file bytes inline. The bytes AND the `mime` come
 * from a `files` row whose content another member can write (PutObject to the
 * shared bucket + the generic row CRUD), so a member could stage `text/html`
 * over the shared bucket and have it execute same-origin in another member's GUI
 * when served `inline`. `X-Content-Type-Options: nosniff` stops a declared
 * `image/*` being sniffed as HTML, and a no-allowances `sandbox` CSP neutralizes
 * script/form/same-origin if an HTML blob is opened directly — while still
 * letting the GUI embed an image/PDF as a subresource for preview.
 */
/**
 * `content-disposition` for a filename that may contain non-ASCII characters.
 * HTTP header values are ISO-8859-1, so a non-Latin-1 char — e.g. the U+202F
 * narrow no-break space macOS puts before AM/PM in screenshot names — makes
 * `res.writeHead` throw `ERR_INVALID_CHAR` and the blob serve 500s (the image
 * never loads). Emit an ASCII-only `filename=` fallback PLUS an RFC 5987
 * `filename*=UTF-8''…` with the real name (RFC 6266).
 */
export function contentDispositionInline(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function blobResponseHeaders(contentType: string, name: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': contentDispositionInline(name),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  // A no-allowances `sandbox` CSP neutralizes an HTML/SVG blob (which a member
  // could stage over the shared bucket) from executing same-origin when opened
  // inline. But that SAME directive also blanks the browser's built-in PDF viewer,
  // which runs its own scripts — so a PDF served with it renders empty. `nosniff`
  // plus the declared `application/pdf` type already stop a non-PDF being sniffed
  // as HTML, so PDFs are served WITHOUT the sandbox so the viewer can display them.
  if (contentType !== 'application/pdf') {
    headers['content-security-policy'] = "default-src 'none'; sandbox";
  }
  return headers;
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
      res.writeHead(200, blobResponseHeaders(contentType, name));
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
        res.writeHead(200, blobResponseHeaders(contentType, name));
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } catch (e) {
        sendJson(res, { error: `file bytes unavailable from S3: ${(e as Error).message}` }, 502);
      }
      return true;
    }

    // Keyless cloud member: the file lives in S3 but this member has no local S3
    // config (only the owner configures one). Presign the GET INSIDE Postgres,
    // gated on this member's row-visibility (the get() above already passed it),
    // and stream the bytes from the returned URL. The member never holds a key.
    // Falls through to the 404 below if the cloud hasn't enabled the presigner
    // (lattice_presign_file absent / no S3 secret configured).
    if (s3 && !s3cfg && ctx.db.getDialect() === 'postgres') {
      try {
        const url = await ctx.db.presignFile(id, 'GET', 60);
        const upstream = await fetch(url);
        if (upstream.ok) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(200, blobResponseHeaders(contentType, name));
          res.end(buf);
          return true;
        }
        sendJson(
          res,
          { error: `file bytes unavailable from S3 (HTTP ${String(upstream.status)})` },
          502,
        );
        return true;
      } catch {
        // Presigner not installed / no secret configured → fall through to 404.
      }
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
    if (!localFileOpenEnabled()) {
      sendJson(res, { enabled: false });
      return true;
    }
    const id = decodeURIComponent(openMatch[1] ?? '');
    const row = (await ctx.db.get('files', id)) as FileRow | null;
    if (!row) {
      sendJson(res, { error: 'file not found' }, 404);
      return true;
    }
    const loc = localPathOf(row, ctx.latticeRoot);
    if (!loc) {
      sendJson(res, { error: 'file has no local path' }, 404);
      return true;
    }
    // Reveal only makes sense for bytes that exist on THIS machine — a member
    // viewing a remote-only (S3) file has nothing local to select.
    if (!localFileExists(loc)) {
      sendJson(res, { error: 'file bytes are not on this machine (stored remotely)' }, 404);
      return true;
    }
    // "Open in Finder" REVEALS the file (selects it in the OS file browser) — it
    // does NOT open it in an app. A content-addressed blob is stored extensionless
    // (data/blobs/<sha256>), so revealing it showed a hash-named generic
    // "Document"; revealTargetFor materializes a named copy of the blob so the
    // user sees their actual image/document name instead.
    const target = revealTargetFor(row, ctx.latticeRoot, loc, id);
    const reveal: { cmd: string; args: string[] } =
      process.platform === 'darwin'
        ? { cmd: 'open', args: ['-R', target] }
        : process.platform === 'win32'
          ? { cmd: 'explorer', args: [`/select,${target}`] }
          : { cmd: 'xdg-open', args: [dirname(target)] }; // no portable file-select on Linux
    try {
      const child = spawn(reveal.cmd, reveal.args, { detached: true, stdio: 'ignore' });
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
