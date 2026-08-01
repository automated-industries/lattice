/**
 * Local source roots, headless: the folders and files a workspace watches.
 *
 * A "root" is a place on this machine the workspace draws documents from — a
 * folder of contracts, a directory of meeting notes, one long-lived file. Adding
 * one registers it and ingests what is inside it; the registry is what later
 * bounds every browse and every re-ingest to somewhere the user actually named.
 *
 * All of this used to live inside the sidebar's request handlers, which made a
 * browser the only way to point a workspace at a folder — for the operation whose
 * most natural caller is a script (prepare a workspace from a directory, re-run a
 * folder nightly, set up the same machine twice). The one part that genuinely
 * needs a person is choosing the path, and a caller that already knows the path
 * does not need to be asked: a path argument IS the headless equivalent of a file
 * picker.
 *
 * Bounded-reads + containment are load-bearing and unchanged: a directory listing
 * is ONE level (never recursive), entry-capped, and confined to a registered
 * root; a folder ingest is a bounded breadth-first walk (depth + file caps), not
 * an unbounded disk scan. No path outside a registered root is ever read.
 *
 * A REFUSAL IS A TAGGED ERROR, never a status: `ingestError` carries a code the
 * adapter maps to whatever its transport uses (see `./ingest-errors.js`).
 */
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
import { randomUUID } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import { configDir } from '../framework/user-config.js';
import type { FeedBus } from '../gui/feed.js';
import type { LocalFileIngestResult } from './ingest-file.js';
import { ingestError } from './ingest-errors.js';

/** A registered on-disk source somebody added to this workspace. */
export interface SourceRoot {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  name: string;
}

/** What the root capabilities need from an open workspace. */
export interface SourceRootDeps {
  db: Lattice;
  /** Ingest one local file in place (the shared core from the ingest capabilities). */
  ingestFile: (absPath: string) => Promise<LocalFileIngestResult>;
  /**
   * Absolute path to the ACTIVE workspace's config file. The roots registry
   * (sources.json) lives next to it (`dirname(configPath)`), so registered
   * folder roots are scoped to this workspace and never leak across workspaces.
   */
  configPath: string;
  /** Optional activity feed for live progress signals. */
  feed?: FeedBus;
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
 * next to its config file (`dirname(configPath)`), so the registered folder roots
 * are scoped to that workspace and NEVER leak into another. (Pre-4.3.2 this was a
 * single machine-global `sources.json` under `configDir()`, shared by every
 * workspace — which is exactly how a brand-new workspace showed another
 * workspace's files.)
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
 * lives on a different filesystem than the shared root (an adopted-in-place
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

/**
 * The on-disk sources this workspace has registered.
 *
 * Reading needs no server and no permission: it is the answer to "where does this
 * workspace get its documents from", which a script setting one up asks first.
 */
export function listSourceRoots(configPath: string): SourceRoot[] {
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
 * Resolve `target` and confirm it is a registered folder root itself or strictly
 * inside one; returns the absolute path, or null when it escapes every root.
 * The trailing-separator check prevents a `/data-evil` sibling from passing a
 * naive `startsWith('/data')`.
 */
export function resolveInsideRoots(target: string, roots: SourceRoot[]): string | null {
  const abs = resolve(target);
  for (const r of roots) {
    if (r.kind !== 'folder') continue;
    const root = resolve(r.path);
    if (abs === root || abs.startsWith(root + sep)) return abs;
  }
  return null;
}

// --- One-level directory listing --------------------------------------------

/** One entry of a directory listing. */
export interface DirEntry {
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

/**
 * List ONE level of a registered folder — never recursive, entry-capped, and
 * refused outright for a path outside every registered root.
 */
export function listSourceFolder(
  configPath: string,
  target: string,
): { entries: DirEntry[]; truncated: boolean } {
  if (!target) throw ingestError('invalid_request', 'path is required');
  const abs = resolveInsideRoots(target, listSourceRoots(configPath));
  if (!abs) throw ingestError('outside_roots', 'path is outside any registered source root');
  try {
    return listOneLevel(abs);
  } catch (e) {
    throw ingestError('not_found', (e as Error).message);
  }
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

/** What a folder ingest brought in, and what it deliberately did not. */
export interface IngestFolderResult {
  ingested: number;
  skipped: number;
  /** Total file paths collected in phase 1 before stopping. */
  scanned: number;
  /** True if phase 1 stopped collection at the scan cap. */
  scanTruncated: boolean;
  /** True if phase 2 stopped at the successful-ingest cap. */
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

// --- The capabilities -------------------------------------------------------

/** What registering a root produced: the root itself, and what came in with it. */
export interface AddSourceRootResult {
  root: SourceRoot;
  result: IngestFolderResult | LocalFileIngestResult;
}

/**
 * Register a place on this machine as a source, and bring in what is there.
 *
 * The whole operation, not half of it: a folder is registered AND walked, a file
 * is registered AND read, because "add this folder" without ingesting it leaves a
 * workspace pointing at documents it has never seen. Registering an already-known
 * path is idempotent — the existing root is kept and its contents re-ingested, so
 * re-running the same command picks up what has changed since.
 *
 * A path that does not exist, or whose kind does not match what was asked for, is
 * refused before anything is written.
 */
export async function addSourceRoot(
  deps: SourceRootDeps,
  input: { path: string; kind?: 'file' | 'folder' },
): Promise<AddSourceRootResult> {
  const path = input.path.trim();
  const kind = input.kind === 'file' ? 'file' : 'folder';
  if (!path) throw ingestError('invalid_request', 'path is required');
  const abs = resolve(path);
  // Stat first, and keep its failure separate from the kind check: "there is
  // nothing here" and "there is something here but it is the other kind" are
  // different mistakes and a caller fixes them differently.
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw ingestError('not_found', `path not found: ${abs}`);
  }
  if (kind === 'folder' && !st.isDirectory())
    throw ingestError('invalid_request', 'path is not a folder');
  if (kind === 'file' && !st.isFile()) throw ingestError('invalid_request', 'path is not a file');
  const roots = listSourceRoots(deps.configPath);
  let root = roots.find((r) => resolve(r.path) === abs);
  if (!root) {
    root = { id: randomUUID(), path: abs, kind, name: basename(abs) || abs };
    roots.push(root);
    writeRoots(deps.configPath, roots);
  }
  // Ingest on add (drives the brain-graph animation via source:'ingest' feed).
  const result =
    kind === 'folder'
      ? await ingestFolder(abs, deps.ingestFile, deps.db, undefined, deps.feed)
      : await deps.ingestFile(abs);
  return { root, result };
}

/**
 * Forget a registered source. The documents already ingested from it stay — this
 * removes the pointer, never anything on disk and never anything in the workspace.
 */
export function removeSourceRoot(configPath: string, id: string): { removed: boolean } {
  const before = listSourceRoots(configPath);
  const after = before.filter((r) => r.id !== id);
  writeRoots(configPath, after);
  return { removed: after.length < before.length };
}

/**
 * Re-ingest everything under a registered folder — a bounded breadth-first walk,
 * capped on depth, on files collected, and on files successfully brought in.
 *
 * Refused for a path outside every registered root: this reads the caller's
 * filesystem, and the registry is the record of which places they meant.
 */
export async function ingestSourceFolder(
  deps: SourceRootDeps,
  target: string,
  caps?: IngestFolderCaps,
): Promise<IngestFolderResult> {
  const abs = resolveInsideRoots(target, listSourceRoots(deps.configPath));
  if (!abs) throw ingestError('outside_roots', 'path is outside any registered source root');
  return ingestFolder(abs, deps.ingestFile, deps.db, caps, deps.feed);
}
