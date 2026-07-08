import { EventEmitter } from 'node:events';
import type { ChatStreamEvent } from './ai/sse.js';

/**
 * In-process bus that streams ONE chat turn's progress to the GUI over the
 * multiplexed `/api/stream` WebSocket — the async replacement for the held-open
 * `POST /api/chat` SSE response. Modeled on {@link RenderProgressBus} / `FeedBus`,
 * but deliberately with NO `latest()` / replay buffer: a reconnecting client recovers
 * from the server-authoritative persisted `chat_messages` (checkpointed as the turn
 * streams), so replaying stale ticks to a fresh socket would only cause double-render.
 *
 * Every envelope carries the turn's `ownerUserId` so the `/api/stream` forwarder can
 * gate delivery PER USER — on a cloud workspace a chat is private to its author, and
 * this bus is per-process (shared across every connected socket), so the gate is
 * load-bearing, not decorative (see `chat-identity` / Stage 5).
 */
export interface ChatProgressEnvelope {
  /** The thread the turn belongs to. */
  threadId: string;
  /** The pending assistant message id — the client filters live events by (thread, message). */
  messageId: string;
  /** Cloud user id of the turn's owner; null on a local (single-user) workspace. */
  ownerUserId: string | null;
  /** The streamed chat event (same union the old SSE response wrote). */
  event: ChatStreamEvent;
}

export class ChatProgressBus {
  private readonly emitter = new EventEmitter();
  private readonly EVENT = 'chat-progress';

  constructor() {
    // Multiple browser tabs each attach one listener; be generous.
    this.emitter.setMaxListeners(64);
  }

  /** Publish one chat-progress envelope to all subscribers. */
  publish(env: ChatProgressEnvelope): void {
    this.emitter.emit(this.EVENT, env);
  }

  /** Subscribe to future envelopes. Returns an unsubscribe function. */
  subscribe(handler: (env: ChatProgressEnvelope) => void): () => void {
    this.emitter.on(this.EVENT, handler);
    return () => this.emitter.off(this.EVENT, handler);
  }

  /** Number of live subscribers (for diagnostics/tests). */
  listenerCount(): number {
    return this.emitter.listenerCount(this.EVENT);
  }
}
