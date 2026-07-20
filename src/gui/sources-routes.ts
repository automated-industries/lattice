import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { resolve, join, basename, sep, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { configDir } from '../framework/user-config.js';
import { localFileOpenEnabled } from './files-routes.js';
import type { LocalFileIngestResult } from './ingest-routes.js';
import type { FeedBus } from './feed.js';
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
  /**
   * Absolute path to the ACTIVE workspace's config file. The roots registry
   * (sources.json) lives next to it (`dirname(configPath)`), so registered
   * folder roots are scoped to this workspace and never leak across workspaces.
   */
  configPath: string;
  pathname: string;
  method: string;
  /** Optional activity feed for live progress signals. */
  feed?: FeedBus;
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
// Upper bound on how many file paths a single folder ingest will COLLECT before it
// stops walking. The cap that matters is MAX_INGEST_FILES *successful* ingests (below);
// this is only a memory guard so a pathological tree can't collect an unbounded path
// list. Set well above MAX_INGEST_FILES so skipped files (too-large / unreadable) never
// starve the success budget — the reason the collect cap is NOT MAX_INGEST_FILES.
const MAX_INGEST_SCAN = 5000;
// How many files a folder ingest processes at once. The per-file bottleneck is
// network-bound LLM enrichment (summary + classify + extract) plus vision, so a
// small fan-out collapses wall-clock without flooding the model API. DB writes stay
// safe under this: row inserts are atomic auto-commits, and the schema mutations they
// trigger (new entity / column / junction) serialize behind the Lattice schema lock.
const INGEST_CONCURRENCY = 4;
// Directories never worth ingesting (huge, derived, or VCS internals).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv']);

// --- Root persistence (machine-local, never cloud-synced) --------------------

/**
 * Per-workspace roots registry path. Each workspace keeps its OWN sources.json
 * next to its config file (`dirname(configPath)` — e.g.
 * `~/.lattice/Workspaces/<dir>/sources.json` for a scaffolded workspace), so the
 * registered folder roots shown in the Files sidebar are scoped to that
 * workspace and NEVER leak into another. (Pre-4.3.2 this was a single
 * machine-global `sources.json` under `configDir()`, shared by every workspace —
 * which is exactly how a brand-new workspace showed another workspace's files.)
 */
function rootsFile(configPath: string): string {
  return join(dirname(configPath), 'sources.json');
}

/**
 * One-time, lazy migration for installs that registered roots before 4.3.2,
 * when roots lived in the machine-global `configDir()/sources.json`. On the
 * first read for a workspace that has no per-workspace registry yet, ADOPT the
 * legacy roots into this workspace and RETIRE the global file so no other (or
 * newly created) workspace can re-inherit them. The roots land in the FIRST
 * workspace opened after upgrade — for the desktop app that is the last-active
 * (primary) workspace it restores on launch.
 *
 * Copy-then-delete (not an atomic rename) so it works even when the workspace
 * lives on a different filesystem than `~/.lattice` (an adopted-in-place
 * `--config`, where a rename would throw EXDEV). The order is load-bearing: the
 * per-workspace file is written BEFORE the global one is removed, so an
 * interruption between the two leaves the legacy file intact (recoverable)
 * rather than losing the roots — and each failure mode is handled explicitly so
 * a failed retire can never silently re-leak.
 */
function migrateGlobalRootsIfNeeded(configPath: string): void {
  const wsFile = rootsFile(configPath);
  if (existsSync(wsFile)) return; // this workspace already has its own registry
  const globalFile = join(configDir(), 'sources.json');
  if (globalFile === wsFile || !existsSync(globalFile)) return; // nothing legacy to adopt

  // Validate the legacy file first; a corrupt or empty one is left untouched.
  let roots: SourceRoot[];
  try {
    const parsed = JSON.parse(readFileSync(globalFile, 'utf8')) as { roots?: SourceRoot[] };
    if (!Array.isArray(parsed.roots) || parsed.roots.length === 0) return;
    roots = parsed.roots;
  } catch {
    return; // unreadable / corrupt → leave it; this workspace just starts empty
  }

  // 1) Write the roots into this workspace (creating its dir if needed). On
  //    failure, leave the legacy file untouched — no adoption, but no data loss.
  try {
    mkdirSync(dirname(wsFile), { recursive: true });
    writeFileSync(wsFile, JSON.stringify({ roots }, null, 2), 'utf8');
  } catch {
    return;
  }

  // 2) Retire the legacy file so the roots are adopted exactly once. If the
  //    delete fails (rare), blank it so no other workspace re-adopts them — the
  //    roots are already safe in this workspace either way.
  try {
    rmSync(globalFile, { force: true });
  } catch {
    try {
      writeFileSync(globalFile, JSON.stringify({ roots: [] }, null, 2), 'utf8');
    } catch {
      /* best-effort; a fresh workspace re-adopting a copy is non-fatal and rare */
    }
  }
}

function readRoots(configPath: string): SourceRoot[] {
  migrateGlobalRootsIfNeeded(configPath);
  try {
    const raw = readFileSync(rootsFile(configPath), 'utf8');
    const parsed = JSON.parse(raw) as { roots?: SourceRoot[] };
    return Array.isArray(parsed.roots) ? parsed.roots : [];
  } catch {
    return []; // absent / unreadable → no roots yet
  }
}
function writeRoots(configPath: string, roots: SourceRoot[]): void {
  writeFileSync(rootsFile(configPath), JSON.stringify({ roots }, null, 2), 'utf8');
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

// --- Ingest progress throttle -----------------------------------------------

/**
 * Decide whether to publish an ingest-progress event now. Throttles to at most
 * one per 5 completions or per 2 seconds (whichever first allows), and always
 * permits terminal events (done >= total).
 *
 * State is NOT persisted across calls — each call is independent. The caller
 * must track state across ingest phases.
 *
 * @param done Number of files successfully ingested so far.
 * @param total Total files to ingest.
 * @param prevDone Files ingested when the last event was published (or 0 on init).
 * @param prevTime Timestamp of the last published event (or 0 on init), in ms.
 * @param nowFn Clock function returning current time in ms (default Date.now).
 * @returns True if an event should be published now.
 */
export function shouldPublishIngestProgress(
  done: number,
  total: number,
  prevDone: number,
  prevTime: number,
  nowFn: () => number = Date.now,
): boolean {
  const now = nowFn();
  // Always publish when done (terminal event).
  if (done >= total) return true;
  // First event (prevTime = 0) or 5+ files completed since last event.
  if (prevTime === 0 || done - prevDone >= 5) return true;
  // 2+ seconds since last event.
  if (now - prevTime >= 2000) return true;
  return false;
}

// --- Bounded folder ingest (BFS) --------------------------------------------

interface IngestFolderCaps {
  maxFiles?: number;
  maxScan?: number;
  maxDepth?: number;
}

interface IngestFolderResult {
  ingested: number;
  skipped: number;
  /** Total file paths collected in phase 1 before stopping. */
  scanned: number;
  /** True if phase 1 stopped collection at MAX_INGEST_SCAN / caps.maxScan. */
  scanTruncated: boolean;
  /** True if phase 2 stopped at MAX_INGEST_FILES / caps.maxFiles success cap. */
  capped: boolean;
}

// Exported for tests: the `caps` override is the only way to exercise the cap
// paths without creating hundreds of files, and it is not exposed via any route.
export async function ingestFolder(
  abs: string,
  ingestFile: (p: string) => Promise<LocalFileIngestResult>,
  db: Lattice,
  caps?: IngestFolderCaps,
  feed?: FeedBus,
): Promise<IngestFolderResult> {
  const maxFiles = caps?.maxFiles ?? MAX_INGEST_FILES;
  const maxScan = caps?.maxScan ?? MAX_INGEST_SCAN;
  const maxDepth = caps?.maxDepth ?? MAX_INGEST_DEPTH;

  // Phase 1 — bounded BFS to COLLECT the files to ingest. The directory walk is cheap
  // (readdir only) and stays sequential + ordered so the depth bound is deterministic
  // and the file order matches the old loop. Collection stops at maxScan purely
  // as a memory guard — the meaningful cap (maxFiles successful ingests) is
  // applied in phase 2, so skipped files here don't reduce how many real files ingest.
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: abs, depth: 0 }];
  let scanTruncated = false;
  walk: while (queue.length) {
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
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (d.isFile()) {
        files.push(full);
        if (files.length >= maxScan) {
          scanTruncated = true;
          break walk;
        }
      }
    }
  }

  // Publish initial progress event if feed is available.
  if (feed) {
    feed.publish({
      table: null,
      op: 'ingest_progress',
      rowId: null,
      source: 'ingest',
      summary: `Ingesting 0 of ${String(files.length)} files…`,
      progress: { done: 0, total: files.length },
    });
  }

  // Phase 2 — ingest the collected files with a bounded concurrent worker pool.
  // Suspend auto-render for the WHOLE batch: each of up to maxFiles writes would
  // otherwise schedule its own render, and because the writes are separated by seconds of
  // LLM latency the debounce can't coalesce them — so each render re-scanned the growing
  // file set (O(N²)). The finally arms exactly ONE coalesced render over everything.
  //
  // A hand-rolled pool (not mapWithConcurrency) because it needs two properties the plain
  // map lacks: (1) STOP once maxFiles files have SUCCESSFULLY ingested — matching
  // the old sequential loop's "cap on successes, not on files examined", so a run of
  // too-large/unreadable files never shrinks how many real files get in; and (2) a file
  // that throws (ingestLocalFile is meant not to, but persist()/createRow can still raise
  // a DB error) is counted as skipped and the pool keeps going — one bad file must not
  // reject the whole batch and leave sibling workers writing AFTER resumeAutoRender ran.
  db.pauseAutoRender();
  let ingested = 0;
  let skipped = 0;
  let lastProgressTime = 0;
  let lastProgressDone = 0;
  try {
    let nextIdx = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (ingested >= maxFiles) return; // success cap reached — stop pulling
        const file = files[nextIdx++];
        if (file === undefined) return; // past the last file
        let r: LocalFileIngestResult | null = null;
        try {
          r = await ingestFile(file);
        } catch (e) {
          // ingestLocalFile is documented not to throw, but a DB/schema error in
          // persist() can still escape. Surface it and treat the file as skipped —
          // never let it reject the batch (Promise.all would abort the pool and leave
          // the other workers writing past the auto-render resume).
          console.error(`[ingest] file failed: ${file}: ${(e as Error).message}`);
        }
        if (r?.id) ingested++;
        else skipped++;
        // Publish throttled progress if feed is available.
        if (
          feed &&
          shouldPublishIngestProgress(ingested, files.length, lastProgressDone, lastProgressTime)
        ) {
          lastProgressTime = Date.now();
          lastProgressDone = ingested;
          feed.publish({
            table: null,
            op: 'ingest_progress',
            rowId: null,
            source: 'ingest',
            summary: `Ingesting ${String(ingested)} of ${String(files.length)} files…`,
            progress: { done: ingested, total: files.length },
          });
        }
      }
    };
    const poolSize = Math.max(1, Math.min(INGEST_CONCURRENCY, files.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    // capped is only meaningful if we actually hit the limit AND there were more files
    const hitFileCap = ingested >= maxFiles && nextIdx < files.length;

    // Publish the terminal progress event if feed is available. `terminal` is
    // explicit because a capped run ends with done < total — the client must
    // not have to guess completion from the counts.
    if (feed) {
      feed.publish({
        table: null,
        op: 'ingest_progress',
        rowId: null,
        source: 'ingest',
        summary: `Ingested ${String(ingested)} of ${String(files.length)} files`,
        progress: { done: ingested, total: files.length, terminal: true },
      });
    }

    return {
      ingested,
      skipped,
      scanned: files.length,
      scanTruncated,
      capped: hitFileCap,
    };
  } finally {
    db.resumeAutoRender();
  }
}

// --- Dispatcher --------------------------------------------------------------

export async function dispatchSourcesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SourcesRouteDeps,
): Promise<boolean> {
  const { pathname, method, ingestFile, configPath } = deps;
  if (!pathname.startsWith('/api/sources/')) return false;

  // Local-filesystem access floor: when disabled, every route degrades to a
  // clear "not available" rather than touching disk.
  if (!localFileOpenEnabled()) {
    sendJson(res, { enabled: false });
    return true;
  }

  // GET /api/sources/roots — the registered roots for the sidebar.
  if (pathname === '/api/sources/roots' && method === 'GET') {
    sendJson(res, { enabled: true, roots: readRoots(configPath) });
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
    const roots = readRoots(configPath);
    let root = roots.find((r) => resolve(r.path) === abs);
    if (!root) {
      root = { id: randomUUID(), path: abs, kind, name: basename(abs) || abs };
      roots.push(root);
      writeRoots(configPath, roots);
    }
    // Ingest on add (drives the brain-graph animation via source:'ingest' feed).
    let result: IngestFolderResult | LocalFileIngestResult;
    if (kind === 'folder')
      result = await ingestFolder(abs, ingestFile, deps.db, undefined, deps.feed);
    else result = await ingestFile(abs);
    sendJson(res, { root, result });
    return true;
  }

  // DELETE /api/sources/roots/:id — drop a root from the sidebar (never disk).
  const delMatch = /^\/api\/sources\/roots\/([^/]+)$/.exec(pathname);
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1] ?? '');
    const roots = readRoots(configPath).filter((r) => r.id !== id);
    writeRoots(configPath, roots);
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
    const abs = safeResolveInside(target, readRoots(configPath));
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
    const abs = safeResolveInside(target, readRoots(configPath));
    if (!abs) {
      sendJson(res, { error: 'path is outside any registered source root' }, 403);
      return true;
    }
    sendJson(res, await ingestFolder(abs, ingestFile, deps.db, undefined, deps.feed));
    return true;
  }

  return false;
}
