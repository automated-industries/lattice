/**
 * Progress reporting for the render engine.
 *
 * A render walks every table and every per-entity context file; for a large
 * database this can take a while. These types let a caller observe progress
 * (per-table %, which table is in flight) and cancel a render in progress via
 * an `AbortSignal`. All of it is optional: a render with no `onProgress` and no
 * `signal` behaves exactly as it did before — zero overhead, identical output.
 */

/** The kind of progress event the render engine emits. */
export type RenderProgressKind = 'table-start' | 'table-progress' | 'table-done' | 'done' | 'error';

/**
 * A single progress event. Fields beyond `kind` describe the table currently
 * being rendered (`table`, `tableIndex`, `tableCount`) and how far along it is
 * (`entitiesRendered`, `entitiesTotal`, `pct`). `durationMs` is set on the
 * terminal `done` event; `message` carries human-readable detail (e.g. the
 * error text on an `error` event).
 */
export interface RenderProgress {
  /** Discriminator: what stage of the render this event reports. */
  kind: RenderProgressKind;
  /** The table being rendered, or null for non-table events (`done`/`error`). */
  table: string | null;
  /** Entities rendered so far within `table` (per-table running count). */
  entitiesRendered: number;
  /** Total entities in `table` — the denominator for the per-table %. */
  entitiesTotal: number;
  /** Zero-based index of `table` among the entity-context tables. */
  tableIndex: number;
  /** Total number of entity-context tables in this render. */
  tableCount: number;
  /** Per-table completion percentage, 0–100, exact (`rendered/total`). */
  pct: number;
  /** Wall-clock duration of the whole render, set on the `done` event. */
  durationMs?: number;
  /** Human-readable detail; the error text on an `error` event. */
  message?: string;
}

/** Sink the render engine pushes {@link RenderProgress} events into. */
export type RenderProgressCallback = (event: RenderProgress) => void;

/**
 * Optional knobs for a render. Both are opt-in:
 * - `onProgress` — observe per-table render progress.
 * - `signal` — cancel a render in flight; the engine bails between entities and
 *   returns the partial manifest (which the caller is expected to discard).
 */
export interface RenderOptions {
  onProgress?: RenderProgressCallback;
  signal?: AbortSignal;
}

/** Default per-table throttle window: at most one passthrough per 200 ms. */
const THROTTLE_WINDOW_MS = 200;

/**
 * Coalesces high-frequency `table-progress` events down to ≤ ~5/sec per table,
 * while always passing through the lifecycle events (`table-start`,
 * `table-done`, `done`, `error`) immediately.
 *
 * A render over a 6,760-row table would otherwise emit thousands of
 * `table-progress` events; this caps it at a few dozen. The throttle lives in
 * the engine so every consumer benefits and no per-entity object crosses the
 * progress boundary more than ~5×/sec.
 *
 * The 200 ms window is reset on every `table-start` (via {@link force}), so each
 * table gets its own fresh budget and the first progress tick of a new table is
 * not suppressed by the previous table's last tick.
 */
export class ProgressThrottle {
  private readonly cb: RenderProgressCallback | undefined;
  private readonly windowMs: number;
  private lastEmit = 0;

  constructor(cb: RenderProgressCallback | undefined, windowMs: number = THROTTLE_WINDOW_MS) {
    this.cb = cb;
    this.windowMs = windowMs;
  }

  /**
   * Emit a `table-progress` event, but only if the window since the last
   * passthrough has elapsed. Dropped events are simply not delivered — the next
   * one that survives carries the latest running count.
   */
  tick(event: RenderProgress): void {
    if (!this.cb) return;
    const now = Date.now();
    if (now - this.lastEmit < this.windowMs) return;
    this.lastEmit = now;
    this.cb(event);
  }

  /**
   * Emit a lifecycle event immediately and reset the throttle window. Use for
   * `table-start`, `table-done`, `done`, and `error` — none of which should
   * ever be dropped. Resetting on `table-start` gives each table a clean budget.
   */
  force(event: RenderProgress): void {
    if (!this.cb) return;
    this.lastEmit = Date.now();
    this.cb(event);
  }
}
