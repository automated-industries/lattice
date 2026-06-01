import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Lattice } from '../lattice.js';
import { sendJson } from './http.js';

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
  pathname: string;
  method: string;
}

interface FileRow {
  path?: string | null;
  ref_kind?: string | null;
  ref_uri?: string | null;
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
function localPathOf(row: FileRow): string | null {
  if (typeof row.path === 'string' && row.path) return row.path;
  if (row.ref_kind === 'local_ref' && typeof row.ref_uri === 'string' && row.ref_uri) {
    return row.ref_uri;
  }
  return null;
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
    const row = (await ctx.db.get('files', id)) as FileRow | null;
    if (!row || row.deleted_at) {
      sendJson(res, { error: 'file not found' }, 404);
      return true;
    }
    const loc = localPathOf(row);
    if (!loc) {
      sendJson(res, { error: 'this file has no underlying blob (text-only ingest)' }, 404);
      return true;
    }
    try {
      const st = statSync(loc);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      sendJson(res, { error: 'referenced file is no longer on disk' }, 410);
      return true;
    }
    const name = sanitizeFilename(row.original_name ?? 'file');
    res.writeHead(200, {
      'content-type':
        typeof row.mime === 'string' && row.mime ? row.mime : 'application/octet-stream',
      'content-disposition': `inline; filename="${name}"`,
      'cache-control': 'no-store',
    });
    const stream = createReadStream(loc);
    stream.on('error', () => {
      // Headers are already sent; just terminate the response.
      res.destroy();
    });
    stream.pipe(res);
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
    const loc = row ? localPathOf(row) : null;
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
