/**
 * File loopback watcher — captures edits to the rendered context tree back into
 * the database, exactly as if they'd been made in the GUI.
 *
 * When the user edits a rendered `.md` file on disk, this watcher runs reverse-
 * sync through the changelog-aware path: the parsed change is written via the
 * same `updateRow` mutation a GUI cell edit uses, so it lands in `__lattice_changelog`
 * (versioned/undoable), fires the activity feed, and triggers auto-render. The
 * render then rewrites the file + manifest, and the next pass recognizes the
 * matching hash as an echo and skips it — no write loop.
 *
 * Frontmatter + body `key: value` fields round-trip automatically. A free-form /
 * custom-rendered file that changed but parses to nothing surfaces a feed notice
 * rather than a guessed (corrupting) write.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { Lattice } from '../lattice.js';
import type { FeedBus } from './feed.js';
import { updateRow, type MutationCtx } from './mutations.js';
import type { ReverseSyncUpdate } from '../schema/entity-context.js';

export interface FileLoopbackWatcherDeps {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  outputDir: string;
  /** Debounce window; must exceed auto-render's so a user's burst settles first. */
  debounceMs?: number;
}

export interface FileLoopbackWatcher {
  start(): void;
  stop(): void;
}

export function createFileLoopbackWatcher(deps: FileLoopbackWatcherDeps): FileLoopbackWatcher {
  const debounceMs = deps.debounceMs ?? 500;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;

  const mctx: MutationCtx = {
    db: deps.db,
    feed: deps.feed,
    softDeletable: deps.softDeletable,
    source: 'file-edit',
  };

  const apply = async (u: ReverseSyncUpdate): Promise<void> => {
    const pkKeys = Object.keys(u.pk);
    const firstKey = pkKeys[0];
    if (pkKeys.length === 1 && firstKey !== undefined) {
      // Single-id PK (the common case) goes through the full GUI mutation path:
      // changelog + activity feed + audit/undo, i.e. "as if made in the GUI".
      await updateRow(mctx, u.table, String(u.pk[firstKey]), u.set);
    } else {
      // Composite PK — versioned changelog write (no single id for the feed path).
      await deps.db.update(u.table, u.pk, u.set, { reason: 'file-edit' });
    }
  };

  const onSkip = (info: { table: string; slug: string; filename: string }): void => {
    deps.feed.publish({
      table: info.table,
      op: 'update',
      rowId: null,
      source: 'file-edit',
      summary: `Edited ${info.filename} on disk — change not auto-importable (custom/computed render)`,
    });
  };

  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    // Never reverse-sync while a render is in flight. A render rewrites the
    // context files + manifest; a pass now would read the render's own (possibly
    // half-written) output before its manifest hash catches up, mismatch the echo
    // check, and re-ingest the render's writes as spurious "file-edit" changes
    // (e.g. "Updated 9006 rows … file-edit"). Defer until the render settles —
    // reschedule so we re-check after the debounce rather than dropping the pass.
    if (deps.db.isRendering()) {
      schedule();
      return;
    }
    running = true;
    try {
      await deps.db.reverseSyncFromFiles(deps.outputDir, { useDefault: true, apply, onSkip });
    } catch (err) {
      // A loopback hiccup must never take the server down — surface and continue.
      console.warn('[latticesql] file-loopback pass failed:', (err as Error).message);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
    timer.unref();
  };

  return {
    start(): void {
      if (watcher) return;
      try {
        watcher = watch(
          deps.outputDir,
          { recursive: true, persistent: false },
          (_event, filename) => {
            if (filename === null) {
              schedule();
              return;
            }
            if (!filename.endsWith('.md')) return; // only rendered markdown
            if (filename.includes('.lattice')) return; // skip render bookkeeping subtrees
            schedule();
          },
        );
      } catch (err) {
        // Recursive watch is unsupported on some platforms — degrade to no
        // loopback rather than crash (manual `reconcile` still works).
        console.warn('[latticesql] file-loopback watcher unavailable:', (err as Error).message);
      }
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        watcher = null;
      }
    },
  };
}
