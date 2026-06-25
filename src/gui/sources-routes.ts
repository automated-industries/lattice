import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, basename, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { configDir } from '../framework/user-config.js';
import { localFileOpenEnabled } from './files-routes.js';
import type { LocalFileIngestResult } from './ingest-routes.js';
import { sendJson, readJson } from './http.js';

/**
 * Sources routes — the local-only backend for the Sources sidebar's Files
 * section: register on-disk roots (a file or a folder), browse a folder ONE
 * level at a time, and ingest a folder's files. Everything here reads the user's
 * own filesystem, so it is gated behind {@link localFileOpenEnabled} (the same
 * LATTICE_LOCAL_OPEN floor as open-in-finder) and is never mounted on team cloud.
 *
 * Bounded-reads + containment are load-bearing: a directory listing is ONE level
 * (never recursive), entry-capped, and confined to a registered root; a folder
 * ingest is a bounded breadth-first walk (depth + file caps), not an unbounded
 * disk scan. No path outside a registered root is ever read.
 */

export interface SourcesRouteDeps {
  db: Lattice;
  /** Ingest one local file in place (the shared core from ingest-routes). */
  ingestFile: (absPath: string) => Promise<LocalFileIngestResult>;
  pathname: string;
  method: string;
}

/** A registered on-disk source the user added to the sidebar. */
interface SourceRoot {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  name: string;
}

// Bounds for the folder walk — a backstop against an unbounded disk crawl.
const MAX_LIST_ENTRIES = 2000;
const MAX_INGEST_FILES = 500;
const MAX_INGEST_DEPTH = 8;
// Directories never worth ingesting (huge, derived, or VCS internals).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv']);

// --- Root persistence (machine-local, never cloud-synced) --------------------

function rootsFile(): string {
  return join(configDir(), 'sources.json');
}
function readRoots(): SourceRoot[] {
  try {
    const raw = readFileSync(rootsFile(), 'utf8');
    const parsed = JSON.parse(raw) as { roots?: SourceRoot[] };
    return Array.isArray(parsed.roots) ? parsed.roots : [];
  } catch {
    return []; // absent / unreadable → no roots yet
  }
}
function writeRoots(roots: SourceRoot[]): void {
  writeFileSync(rootsFile(), JSON.stringify({ roots }, null, 2), 'utf8');
}

/**
 * Resolve `target` and confirm it is the registered root itself or strictly
 * inside it; returns the absolute path, or null when it escapes every root.
 * The trailing-separator check prevents a `/data-evil` sibling from passing a
 * naive `startsWith('/data')`.
 */
function safeResolveInside(target: string, roots: SourceRoot[]): string | null {
  const abs = resolve(target);
  for (const r of roots) {
    if (r.kind !== 'folder') continue;
    const root = resolve(r.path);
    if (abs === root || abs.startsWith(root + sep)) return abs;
  }
  return null;
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

// --- One-level directory listing --------------------------------------------

interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'folder';
}
function listOneLevel(abs: string): { entries: DirEntry[]; truncated: boolean } {
  const dirents = readdirSync(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  let truncated = false;
  for (const d of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
    if (d.name.startsWith('.')) continue; // hide dotfiles
    if (d.isSymbolicLink()) continue; // never traverse symlinks
    if (d.isDirectory()) entries.push({ name: d.name, path: join(abs, d.name), kind: 'folder' });
    else if (d.isFile()) entries.push({ name: d.name, path: join(abs, d.name), kind: 'file' });
  }
  // Folders first, then files, each alphabetical.
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  );
  return { entries, truncated };
}

/** readdir with file types, returning null on an unreadable directory. */
function readdirSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// --- Bounded folder ingest (BFS) --------------------------------------------

async function ingestFolder(
  abs: string,
  ingestFile: (p: string) => Promise<LocalFileIngestResult>,
): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: abs, depth: 0 }];
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    const { dir, depth } = item;
    const dirents = readdirSafe(dir);
    if (!dirents) continue; // unreadable dir — skip, don't abort the whole walk
    for (const d of dirents) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      if (d.isSymbolicLink()) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_INGEST_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      } else if (d.isFile()) {
        if (ingested >= MAX_INGEST_FILES) return { ingested, skipped };
        const r = await ingestFile(full);
        if (r.id) ingested++;
        else skipped++;
      }
    }
  }
  return { ingested, skipped };
}

// --- Dispatcher --------------------------------------------------------------

export async function dispatchSourcesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SourcesRouteDeps,
): Promise<boolean> {
  const { pathname, method, ingestFile } = deps;
  if (!pathname.startsWith('/api/sources/')) return false;

  // Local-filesystem access floor: when disabled, every route degrades to a
  // clear "not available" rather than touching disk.
  if (!localFileOpenEnabled()) {
    sendJson(res, { enabled: false });
    return true;
  }

  // GET /api/sources/roots — the registered roots for the sidebar.
  if (pathname === '/api/sources/roots' && method === 'GET') {
    sendJson(res, { enabled: true, roots: readRoots() });
    return true;
  }

  // POST /api/sources/roots {path, kind} — register a root + ingest on add.
  if (pathname === '/api/sources/roots' && method === 'POST') {
    const body = await readJson<{ path?: unknown; kind?: unknown }>(req).catch(() => ({}) as never);
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    const kind = body.kind === 'file' ? 'file' : 'folder';
    if (!path) {
      sendJson(res, { error: 'path is required' }, 400);
      return true;
    }
    const abs = resolve(path);
    try {
      const st = statSync(abs);
      if (kind === 'folder' && !st.isDirectory()) {
        sendJson(res, { error: 'path is not a folder' }, 400);
        return true;
      }
      if (kind === 'file' && !st.isFile()) {
        sendJson(res, { error: 'path is not a file' }, 400);
        return true;
      }
    } catch {
      sendJson(res, { error: `path not found: ${abs}` }, 400);
      return true;
    }
    const roots = readRoots();
    let root = roots.find((r) => resolve(r.path) === abs);
    if (!root) {
      root = { id: randomUUID(), path: abs, kind, name: basename(abs) || abs };
      roots.push(root);
      writeRoots(roots);
    }
    // Ingest on add (drives the brain-graph animation via source:'ingest' feed).
    let result: { ingested: number; skipped: number } | LocalFileIngestResult;
    if (kind === 'folder') result = await ingestFolder(abs, ingestFile);
    else result = await ingestFile(abs);
    sendJson(res, { root, result });
    return true;
  }

  // DELETE /api/sources/roots/:id — drop a root from the sidebar (never disk).
  const delMatch = /^\/api\/sources\/roots\/([^/]+)$/.exec(pathname);
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1] ?? '');
    const roots = readRoots().filter((r) => r.id !== id);
    writeRoots(roots);
    sendJson(res, { ok: true });
    return true;
  }

  // POST /api/sources/pick {kind} — native OS picker; null path = cancelled.
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
    if (!target) {
      sendJson(res, { error: 'path is required' }, 400);
      return true;
    }
    const abs = safeResolveInside(target, readRoots());
    if (!abs) {
      sendJson(res, { error: 'path is outside any registered source root' }, 403);
      return true;
    }
    try {
      sendJson(res, listOneLevel(abs));
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 400);
    }
    return true;
  }

  // POST /api/sources/ingest-folder {path} — bounded BFS ingest, root-contained.
  if (pathname === '/api/sources/ingest-folder' && method === 'POST') {
    const body = await readJson<{ path?: unknown }>(req).catch(() => ({}) as never);
    const target = typeof body.path === 'string' ? body.path : '';
    const abs = safeResolveInside(target, readRoots());
    if (!abs) {
      sendJson(res, { error: 'path is outside any registered source root' }, 403);
      return true;
    }
    sendJson(res, await ingestFolder(abs, ingestFile));
    return true;
  }

  return false;
}
