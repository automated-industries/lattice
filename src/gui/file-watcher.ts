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
  /**
   * Run a reverse-sync pass NOW (bypassing the debounce), awaiting completion.
   * Wired as the auto-render drain so pending manual edits are ingested through
   * the full GUI mutation path (changelog + feed + undo) before a render
   * rewrites the files.
   */
  flush(): Promise<void>;
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
    // A custom/computed-render file that changed on disk but parses to nothing
    // produces no importable update. This is an EXPECTED, non-actionable condition
    // — the render owns the file, and free-form / custom renders never round-trip —
    // so it must NOT surface in the activity feed. It was publishing one feed event
    // per reverse-sync pass, which (as the reverse-sync chases each render) floods
    // the feed with duplicate, useless "not auto-importable" notices. A genuine
    // conflict (the DB row changed since render) is still surfaced separately in
    // run(). Diagnostic log only, gated behind a debug flag.
    if (process.env.LATTICE_DEBUG_REVERSE_SYNC) {
      console.debug(
        `[latticesql] reverse-sync: ${info.filename} (${info.table}) changed on disk but is not ` +
          `auto-importable (custom/computed render) — skipped`,
      );
    }
  };

  const run = async (force = false): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    // Never reverse-sync while a render is in flight, UNLESS this is the render's
    // own pre-render drain (force). A background/auto render marks itself in-flight
    // and THEN calls this drain to ingest pending manual edits before it overwrites
    // the files — so at drain time isRendering() is already true by design, and the
    // files on disk are the PRIOR (manifest-consistent) render plus the manual edits
    // we must capture. Honouring the guard here would make the drain a no-op and let
    // the render clobber those edits. The fs-watch debounced path (force=false) still
    // defers: a pass mid-render would read the render's own half-written output before
    // its manifest hash catches up and re-ingest those writes as spurious "file-edit"
    // changes — reschedule so we re-check after the debounce rather than dropping it.
    if (!force && deps.db.isRendering()) {
      schedule();
      return;
    }
    running = true;
    try {
      const rs = await deps.db.reverseSyncFromFiles(deps.outputDir, {
        useDefault: true,
        apply,
        onSkip,
      });
      // A rejected edit (the DB row changed since the file was rendered) must be
      // surfaced, never silently dropped — the render that follows will overwrite
      // the file with current DB state, so tell the editor their change was not
      // imported and why, so they can re-apply it against the updated record.
      for (const c of rs.conflicts) {
        deps.feed.publish({
          table: c.table,
          op: 'update',
          rowId: null,
          source: 'file-edit',
          summary: `Edited ${c.filename} on disk, but the record changed elsewhere since it was rendered — your file edit was NOT imported (it would have overwritten the newer change). Re-apply it against the updated record.`,
        });
      }
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
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Force past the isRendering() guard: flush IS the render's pre-render drain,
      // so isRendering() is already true here by design — see run()'s guard comment.
      await run(true);
    },
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
