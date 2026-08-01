import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import type { Lattice } from '../lattice.js';
import { localFileOpenEnabled } from './files-routes.js';
import type { LocalFileIngestResult } from '../ops/ingest-file.js';
import type { FeedBus } from './feed.js';
import { sendJson, readJson } from './http.js';
import { ingestErrorCode, type IngestErrorCode } from '../ops/ingest-errors.js';
import {
  addSourceRoot,
  ingestSourceFolder,
  listSourceFolder,
  listSourceRoots,
  removeSourceRoot,
  type SourceRootDeps,
} from '../ops/source-roots.js';

/**
 * Sources routes — the HTTP adapter over the source-root capabilities, and the
 * local-only backend for the Sources sidebar's Files section.
 *
 * The WORK — register an on-disk root, browse a folder ONE level at a time,
 * ingest a folder's files — lives in `ops/source-roots.ts`, where a command, a
 * job, or a library caller reaches it without a server. Everything here reads the
 * user's own filesystem, so the whole dispatcher is gated behind
 * {@link localFileOpenEnabled} (the same floor as open-in-finder) and is never
 * mounted on team cloud.
 *
 * The native picker is the one thing that stays: it opens an operating-system
 * dialog and waits for a person. A caller that already knows the path does not
 * need one, which is why every other route here takes a path.
 */

export interface SourcesRouteDeps extends SourceRootDeps {
  db: Lattice;
  /** Ingest one local file in place (the shared core from the ingest capabilities). */
  ingestFile: (absPath: string) => Promise<LocalFileIngestResult>;
  configPath: string;
  pathname: string;
  method: string;
  /** Optional activity feed for live progress signals. */
  feed?: FeedBus;
}

// The source-root capabilities live outside this HTTP adapter. Re-exported here
// so callers that predate the move keep working unchanged.
export {
  ingestFolder,
  shouldPublishIngestProgress,
  listSourceRoots,
  addSourceRoot,
  removeSourceRoot,
  ingestSourceFolder,
  listSourceFolder,
} from '../ops/source-roots.js';
export type { SourceRoot, IngestFolderResult, DirEntry } from '../ops/source-roots.js';

/** The status each refusal code answers with on this transport. */
const STATUS_BY_CODE: Record<IngestErrorCode, number> = {
  invalid_request: 400,
  not_found: 400,
  too_large: 413,
  outside_roots: 403,
  local_files_disabled: 403,
  source_unreachable: 502,
};

/**
 * Answer a thrown value. A tagged refusal becomes its own status; anything else
 * is a real fault and is reported as one rather than dressed up as a client
 * mistake.
 */
function sendSourcesFailure(res: ServerResponse, e: unknown, context: string): boolean {
  const code = ingestErrorCode(e);
  const message = e instanceof Error ? e.message : String(e);
  if (code !== undefined) {
    sendJson(res, { error: message }, STATUS_BY_CODE[code]);
    return true;
  }
  console.error(`[sources] ${context} failed: ${message}\n${(e as Error).stack ?? ''}`);
  sendJson(res, { error: message }, 500);
  return true;
}

// --- Native file/folder picker (best-effort, per-platform) -------------------

function pickNative(kind: 'file' | 'folder'): Promise<string | null> {
  return new Promise((resolveP) => {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      const choose = kind === 'folder' ? 'choose folder' : 'choose file';
      cmd = 'osascript';
      args = ['-e', `POSIX path of (${choose})`];
    } else if (process.platform === 'win32') {
      const ps =
        kind === 'folder'
          ? "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
          : "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }";
      cmd = 'powershell';
      args = ['-NoProfile', '-STA', '-Command', ps];
    } else {
      cmd = 'zenity';
      args = kind === 'folder' ? ['--file-selection', '--directory'] : ['--file-selection'];
    }
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout) => {
      // A non-zero exit means the user cancelled (or the tool is missing) — both
      // resolve to null (no path chosen), never an error the GUI must handle.
      if (err) {
        resolveP(null);
        return;
      }
      const path = (stdout || '').trim();
      resolveP(path || null);
    });
  });
}

// --- Dispatcher --------------------------------------------------------------

export async function dispatchSourcesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SourcesRouteDeps,
): Promise<boolean> {
  const { pathname, method, configPath } = deps;
  if (!pathname.startsWith('/api/sources/')) return false;

  // Local-filesystem access floor: when disabled, every route degrades to a
  // clear "not available" rather than touching disk.
  if (!localFileOpenEnabled()) {
    sendJson(res, { enabled: false });
    return true;
  }

  // GET /api/sources/roots — the registered roots for the sidebar.
  if (pathname === '/api/sources/roots' && method === 'GET') {
    sendJson(res, { enabled: true, roots: listSourceRoots(configPath) });
    return true;
  }

  // POST /api/sources/roots {path, kind} — register a root + ingest on add.
  // @capability source-root.add
  if (pathname === '/api/sources/roots' && method === 'POST') {
    const body = await readJson<{ path?: unknown; kind?: unknown }>(req).catch(() => ({}) as never);
    const path = typeof body.path === 'string' ? body.path : '';
    const kind = body.kind === 'file' ? 'file' : 'folder';
    try {
      sendJson(res, await addSourceRoot(deps, { path, kind }));
    } catch (e) {
      return sendSourcesFailure(res, e, `registering ${path}`);
    }
    return true;
  }

  // DELETE /api/sources/roots/:id — drop a root from the sidebar (never disk).
  const delMatch = /^\/api\/sources\/roots\/([^/]+)$/.exec(pathname);
  // @capability source-root.remove
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1] ?? '');
    removeSourceRoot(configPath, id);
    sendJson(res, { ok: true });
    return true;
  }

  // POST /api/sources/pick {kind} — native OS picker; null path = cancelled.
  // @gui-only local-file-picker: opens the operating system file chooser and waits for a
  // person to select something. There is nothing to call headlessly — a caller that already
  // knows the path does not need a picker, and one that does not cannot be answered.
  if (pathname === '/api/sources/pick' && method === 'POST') {
    const body = await readJson<{ kind?: unknown }>(req).catch(() => ({}) as never);
    const kind = body.kind === 'file' ? 'file' : 'folder';
    const path = await pickNative(kind);
    sendJson(res, { enabled: true, path, cancelled: path === null });
    return true;
  }

  // GET /api/sources/list?path=<abs> — ONE directory level, root-contained.
  if (pathname === '/api/sources/list' && method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = url.searchParams.get('path') ?? '';
    try {
      sendJson(res, listSourceFolder(configPath, target));
    } catch (e) {
      return sendSourcesFailure(res, e, `listing ${target}`);
    }
    return true;
  }

  // POST /api/sources/ingest-folder {path} — bounded BFS ingest, root-contained.
  // @capability source-root.ingest-folder
  if (pathname === '/api/sources/ingest-folder' && method === 'POST') {
    const body = await readJson<{ path?: unknown }>(req).catch(() => ({}) as never);
    const target = typeof body.path === 'string' ? body.path : '';
    try {
      sendJson(res, await ingestSourceFolder(deps, target));
    } catch (e) {
      return sendSourcesFailure(res, e, `ingesting ${target}`);
    }
    return true;
  }

  return false;
}
