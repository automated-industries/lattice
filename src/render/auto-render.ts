import type { RenderResult } from '../types.js';
import type { RenderOptions } from './progress.js';
import type { LatticeManifest } from '../lifecycle/manifest.js';
import type { CleanupOptions, CleanupResult } from '../lifecycle/cleanup.js';

/**
 * Dependencies threaded into {@link AutoRenderScheduler} as bound closures by the
 * owning Lattice's lazy getter. Keeping these as deps (rather than importing the
 * engine / manifest helpers directly) lets this module import ONLY types, so it
 * never reaches back into `lattice.ts` and introduces no import cycle.
 */
export interface AutoRenderDeps {
  /** Bound to `this._render.render` on the owning Lattice. */
  render: (outputDir: string, opts?: RenderOptions) => Promise<RenderResult>;
  /** Bound to `this._render.cleanup`. Third arg is the imported CleanupOptions. */
  cleanup: (
    outputDir: string,
    prevManifest: LatticeManifest | null,
    options?: CleanupOptions,
    newManifest?: LatticeManifest | null,
  ) => Promise<CleanupResult>;
  /** Read the on-disk manifest for `outputDir` (or null when absent). */
  readManifest: (outputDir: string) => LatticeManifest | null;
  /** Fan-out a successful render to the owning Lattice's render handlers. */
  emitRender: (result: RenderResult) => void;
  /** Fan-out a render error to the owning Lattice's error handlers. */
  emitError: (error: Error) => void;
  /** Live getter (NOT a snapshot) for the owning Lattice's `_initialized` flag. */
  isInitialized: () => boolean;
}

/**
 * Owns the auto-render debounce + single-flight scheduler that keeps the
 * SQL→markdown bridge current automatically. Extracted from the Lattice class as
 * a deps-threaded collaborator (mirrors the `_seed`/`_report`/`_encryption` lazy
 * getters); behavior is byte-identical to the prior inline implementation.
 *
 * The scheduler holds the single in-flight flag shared by BOTH the mutation-
 * driven debounced render ({@link _run}) and the guarded fire-and-forget render
 * ({@link runGuarded}) — so the two never overlap on the same dir. Undefined dir
 * = inert: a Lattice that never enables auto-render pays zero overhead.
 */
export class AutoRenderScheduler {
  private _dir: string | undefined;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _pending = false;
  private _inFlight = false;
  private _debounceMs = 250;
  /**
   * Incremental render scope, accumulated between debounced renders. A write or a
   * remote (cloud) change records the AFFECTED table here, so the next render
   * re-renders only that entity (+ its cross-table dependents) instead of the whole
   * tree. `_pendingAll` forces a full render (the initial render, or a change with
   * no known table). Captured + reset when a render starts, so changes during a
   * render re-accumulate and re-trigger.
   */
  private _pendingTables = new Set<string>();
  private _pendingAll = true;

  constructor(private readonly deps: AutoRenderDeps) {}

  /**
   * Turn on automatic rendering into `outputDir`. After this, every scheduled
   * tick debounce-triggers a re-render (coalesced).
   */
  enable(outputDir: string, opts: { debounceMs?: number } = {}): void {
    this._dir = outputDir;
    if (opts.debounceMs != null) this._debounceMs = opts.debounceMs;
  }

  /**
   * Turn off automatic rendering and cancel any pending render. Intentionally
   * does NOT clear `_inFlight` — an in-flight render keeps running to completion
   * and clears the flag itself in its `finally`. (Contrast {@link dispose}.)
   */
  disable(): void {
    this._dir = undefined;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._pending = false;
    // Reset the render scope so a re-enable starts fresh (default = full render).
    this._pendingAll = true;
    this._pendingTables = new Set();
  }

  /**
   * Tear down for close(): clears dir/timer/pending AND `_inFlight`. (Contrast
   * {@link disable}, which leaves `_inFlight` alone.)
   */
  dispose(): void {
    this._dir = undefined;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._pending = false;
    this._inFlight = false;
    this._pendingAll = true;
    this._pendingTables = new Set();
  }

  /** True while a render is actively writing the context tree + manifest. */
  isInFlight(): boolean {
    return this._inFlight;
  }

  schedule(table?: string): void {
    if (!this._dir) return;
    // Record the render scope: a specific changed table → incremental; no table →
    // a full render. (A later full request never narrows a pending one.)
    if (table === undefined) this._pendingAll = true;
    else this._pendingTables.add(table);
    this._pending = true;
    this._armTimer();
  }

  /**
   * Arm the debounce timer if not already armed. Does NOT touch the render scope —
   * used by {@link schedule} AND the post-render re-arm, so a re-arm never escalates
   * a pending incremental render to a full one.
   */
  private _armTimer(): void {
    if (!this._dir || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      void this._run();
    }, this._debounceMs);
    // Don't keep the event loop alive solely for a pending auto-render.
    this._timer.unref();
  }

  /**
   * Shared single-flight render path used by `renderInBackground`.
   *
   * Holds {@link _inFlight} for the render's duration so the mutation-driven
   * {@link _run} defers while this render runs (it sees the flag and marks itself
   * pending instead of starting a second, overlapping render). On settle,
   * `finally` clears the flag and re-arms a single coalesced follow-up render if
   * any mutation arrived mid-flight. Errors propagate to the caller; the flag is
   * always cleared.
   */
  async runGuarded(outputDir: string, opts: RenderOptions): Promise<RenderResult> {
    // A full background render (no `changedTables`) satisfies any queued render
    // scope, so clear it — this is what prevents the open render from being
    // followed by a redundant second full render. Changes that land DURING this
    // render re-accumulate via schedule() and trigger an incremental follow-up.
    if (!opts.changedTables) {
      this._pendingAll = false;
      this._pendingTables = new Set();
      this._pending = false;
    }
    // If an auto-render is already in flight, wait for it to clear before
    // claiming the guard so the two never overlap on the same dir.
    while (this._inFlight) {
      await new Promise((r) => setImmediate(r));
    }
    this._inFlight = true;
    try {
      const result = await this.deps.render(outputDir, opts);
      this.deps.emitRender(result);
      return result;
    } finally {
      this._inFlight = false;
      // A mutation may have arrived during the render (hitting the in-flight
      // guard in _run without arming a timer); re-arm so exactly one
      // coalesced follow-up render runs.
      this._rearmIfPending();
    }
  }

  private async _run(): Promise<void> {
    const dir = this._dir;
    if (!dir || !this.deps.isInitialized()) return;
    if (this._inFlight) {
      // A render is mid-flight (auto-render OR a guarded background render);
      // mark pending and re-arm when it finishes so we coalesce into exactly
      // one follow-up render rather than overlapping.
      this._pending = true;
      return;
    }
    if (!this._pending) return;
    this._pending = false;
    // Capture + reset the render scope NOW so changes that land during this render
    // re-accumulate and re-trigger a follow-up render.
    const renderAll = this._pendingAll;
    const changed = this._pendingTables;
    this._pendingAll = false;
    this._pendingTables = new Set();
    this._inFlight = true;
    try {
      // Read the prior manifest BEFORE render so cleanup can detect orphans.
      const prevManifest = this.deps.readManifest(dir);
      // Incremental when we know exactly which tables changed; full otherwise.
      const renderOpts: RenderOptions =
        renderAll || changed.size === 0 ? {} : { changedTables: changed };
      const result = await this.deps.render(dir, renderOpts);
      this.deps.emitRender(result);
      // Prune stale files after render: a deleted row, or — for a cloud member —
      // a row that was just un-shared (so it dropped out of the RLS-filtered read)
      // must leave the rendered tree, not linger as a stale snapshot. cleanup uses
      // the SAME per-viewer resolver the render did, so a member's own just-written
      // files are kept and only genuinely-absent rows are removed. Without this an
      // un-share would never prune the file (render only writes; it never deletes).
      const newManifest = this.deps.readManifest(dir);
      await this.deps.cleanup(dir, prevManifest, {}, newManifest);
    } catch (err) {
      // A render write failed (e.g. disk full / read-only mount). Surface it
      // loudly through the existing error channel — never swallow it — carrying
      // the original errno code and an actionable message. The prior rendered
      // context + manifest are left intact as the record (the manifest is the
      // last write, so it is never committed over a partial tree), and the next
      // render self-heals once the cause clears.
      const base = err instanceof Error ? err : new Error(String(err));
      const code = (base as NodeJS.ErrnoException).code;
      const error = new Error(
        `render write failed${code ? ` (${code})` : ''}; the prior rendered context + manifest are left intact as the record, and the next render self-heals: ${base.message}`,
      ) as NodeJS.ErrnoException;
      if (code) error.code = code;
      error.cause = base;
      this.deps.emitError(error);
    } finally {
      this._inFlight = false;
      // Mutations may have arrived while the render was in flight (and hit the
      // in-flight guard above without arming a timer); re-arm if so.
      this._rearmIfPending();
    }
  }

  private _rearmIfPending(): void {
    // Re-arm the timer only — the pending render SCOPE is already recorded, so this
    // must NOT call schedule() (which, arg-less, would force a full render).
    if (this._pending) this._armTimer();
  }
}
