import { EventEmitter } from 'node:events';

/**
 * In-process activity feed for the GUI sidebar.
 *
 * Every data mutation the server performs — whether driven by a UI button,
 * the command palette, or a CLI write — is published here as a
 * {@link FeedEvent}. The sidebar subscribes (over SSE) and renders each event
 * as a feed bubble, so the rail doubles as a live activity log.
 *
 * This bus works for every dialect, including local SQLite. The Postgres-only
 * realtime broker (LISTEN/NOTIFY) covers changes made by *other* clients on a
 * shared cloud database; those are merged into the same stream upstream. This
 * bus covers changes made by *this* server process.
 */

/** The kind of mutation a feed event describes. */
export type FeedOp =
  | 'insert'
  | 'update'
  | 'delete'
  | 'link'
  | 'unlink'
  | 'undo'
  | 'redo'
  | 'schema'
  // A clarification question changed state (enqueued / answered / dismissed).
  // Not a data mutation: the client reacts by reconciling its pending-question
  // cards (and the trigger dot) instead of painting an activity card.
  | 'question'
  // A chat thread's AI-generated title landed (it is written AFTER the stream
  // closes, so the client's stream-close thread-list refresh misses it). Not a
  // data mutation: the client reacts by refreshing the conversation list so the
  // friendly title replaces the first-message placeholder.
  | 'thread_title'
  // A folder ingest is progressing. Not a data mutation: the client reacts by
  // updating a progress bar reflecting how many files have been ingested. The
  // progress payload is present only on this op.
  | 'ingest_progress';

/**
 * Who originated the mutation. Drives the source pill shown next to a feed
 * bubble so the user can tell apart their own clicks, command-palette runs,
 * and CLI writes. `system` is Lattice acting on its own (e.g. an automatic
 * de-duplication pass) — attributed to "Lattice" rather than a person.
 */
export type FeedSource = 'gui' | 'command' | 'ai' | 'ingest' | 'cli' | 'system' | 'file-edit';

export interface FeedEvent {
  /** Monotonically increasing per-bus sequence number, assigned on publish. */
  seq: number;
  /** Table the mutation touched, or null for non-table events. */
  table: string | null;
  /** The mutation kind. */
  op: FeedOp;
  /** Primary key of the affected row, when applicable. */
  rowId: string | null;
  /** Originator of the mutation. */
  source: FeedSource;
  /** ISO-8601 UTC timestamp of publication. */
  ts: string;
  /** Optional human-readable one-liner (e.g. "Created row in People"). */
  summary?: string;
  /**
   * Ingest progress snapshot (present only on op: 'ingest_progress').
   * `terminal` marks the batch's final event explicitly — the client cannot
   * infer completion from `done >= total`, because a capped folder ingest
   * legitimately finishes with fewer files ingested than were found.
   */
  progress?: { done: number; total: number; terminal?: boolean };
}

/** A feed event before the bus has assigned its sequence number + timestamp. */
export type FeedEventInput = Omit<FeedEvent, 'seq' | 'ts'> & { ts?: string };

export type FeedHandler = (event: FeedEvent) => void;

const EVENT = 'feed';
const DEFAULT_BUFFER = 100;

/**
 * A subscribable activity feed with a bounded replay buffer.
 *
 * `subscribe` returns an unsubscribe function (matching the realtime broker's
 * convention). New SSE connections call `recent(n)` to backfill the last few
 * events so a freshly opened sidebar isn't blank.
 */
export class FeedBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: FeedEvent[] = [];
  private readonly bufferSize: number;
  private seq = 0;

  constructor(bufferSize: number = DEFAULT_BUFFER) {
    if (bufferSize <= 0) {
      throw new Error('FeedBus bufferSize must be a positive integer');
    }
    this.bufferSize = bufferSize;
    // Multiple browser tabs each attach one listener; be generous.
    this.emitter.setMaxListeners(64);
  }

  /** Publish an event. Assigns the next `seq` and a `ts` if absent. */
  publish(input: FeedEventInput): FeedEvent {
    this.seq += 1;
    const event: FeedEvent = {
      seq: this.seq,
      table: input.table,
      op: input.op,
      rowId: input.rowId,
      source: input.source,
      ts: input.ts ?? new Date().toISOString(),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
    };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    this.emitter.emit(EVENT, event);
    return event;
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(handler: FeedHandler): () => void {
    this.emitter.on(EVENT, handler);
    return () => this.emitter.off(EVENT, handler);
  }

  /** The most recent `n` events (oldest first), for SSE backfill on connect. */
  recent(n: number): FeedEvent[] {
    if (n <= 0) return [];
    return this.buffer.slice(-n);
  }

  /** Number of live subscribers (for diagnostics/tests). */
  listenerCount(): number {
    return this.emitter.listenerCount(EVENT);
  }
}
