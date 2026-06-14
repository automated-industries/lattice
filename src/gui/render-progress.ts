import { EventEmitter } from 'node:events';
import type { RenderProgress } from '../render/progress.js';

/**
 * In-process bus for render progress events in the GUI.
 *
 * The background render publishes per-table progress here; the GUI subscribes
 * (over SSE) and paints a per-card progress bar. This mirrors {@link FeedBus}
 * but deliberately omits the bounded replay buffer: progress events are
 * high-frequency and ephemeral, so replaying the last N would flood a freshly
 * connected tab with stale ticks. Instead a late tab catches up from
 * {@link latest} (the most recent event) plus the server's status snapshot.
 *
 * Works for every dialect, including local SQLite — which is precisely the
 * large-local-table case the realtime (Postgres-only) broker can't cover.
 */
export class RenderProgressBus {
  private readonly emitter = new EventEmitter();
  private readonly EVENT = 'render-progress';
  private _latest: RenderProgress | null = null;

  constructor() {
    // Multiple browser tabs each attach one listener; be generous.
    this.emitter.setMaxListeners(64);
  }

  /** Publish a render progress event to all subscribers. */
  publish(event: RenderProgress): void {
    this._latest = event;
    this.emitter.emit(this.EVENT, event);
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(handler: (event: RenderProgress) => void): () => void {
    this.emitter.on(this.EVENT, handler);
    return () => this.emitter.off(this.EVENT, handler);
  }

  /** The most recently published event, or null if none yet. */
  latest(): RenderProgress | null {
    return this._latest;
  }

  /** Number of live subscribers (for diagnostics/tests). */
  listenerCount(): number {
    return this.emitter.listenerCount(this.EVENT);
  }
}
