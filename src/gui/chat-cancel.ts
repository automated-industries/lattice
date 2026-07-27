/**
 * Per-process registry of the chat turns that are currently running, so a turn can
 * actually be STOPPED.
 *
 * `POST /api/chat` does not hold its response open: it persists a pending row, acks
 * 202 with the thread + message id, and the turn then runs as a detached background
 * job that streams over the realtime WebSocket. Aborting the browser's fetch would
 * therefore stop nothing — the job keeps calling the model, keeps writing to the
 * workspace, and keeps spending tokens. Stopping has to happen on the server, so each
 * running turn registers an {@link AbortController} here under its assistant message
 * id and removes it once the job settles.
 *
 * Modeled on the chat-progress bus: ONE instance per process, shared by every request
 * on the workspace. Each entry carries the turn's owner, so a stop request arriving on
 * a shared cloud workspace can be refused when it did not come from the member who
 * started the turn.
 */

export interface ChatCancelEntry {
  /** The pending assistant message id — the key a stop request arrives with. */
  readonly messageId: string;
  /** The thread the turn belongs to (needed to address its progress frames). */
  readonly threadId: string;
  /** Cloud user id of the turn's owner; null on a local (single-user) workspace. */
  readonly ownerUserId: string | null;
  /** Aborted by a stop request; observed by the tool loop and the model stream. */
  readonly controller: AbortController;
}

export class ChatCancelRegistry {
  private readonly entries = new Map<string, ChatCancelEntry>();

  /**
   * Register a turn that is about to run. Returns the entry (the caller keeps its
   * `controller.signal` and threads it through the loop). Registering the same id
   * twice replaces the previous entry — message ids are freshly generated per turn,
   * so that only happens if a caller reuses one, and the newest turn is the live one.
   */
  register(messageId: string, threadId: string, ownerUserId: string | null): ChatCancelEntry {
    const entry: ChatCancelEntry = {
      messageId,
      threadId,
      ownerUserId,
      controller: new AbortController(),
    };
    this.entries.set(messageId, entry);
    return entry;
  }

  /** The registered entry for a running turn, or undefined when it is not running. */
  get(messageId: string): ChatCancelEntry | undefined {
    return this.entries.get(messageId);
  }

  /**
   * Abort a running turn. Returns false when the id is not registered — a turn that
   * already finished (or never started) is nothing to stop, which is a benign no-op,
   * not a failure. The entry is left in place: the owning job removes it in its
   * `finally` once it has observed the abort and settled its row.
   */
  abort(messageId: string): boolean {
    const entry = this.entries.get(messageId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Drop a turn's entry once its job has settled. Safe to call more than once. */
  release(messageId: string): void {
    this.entries.delete(messageId);
  }

  /** Number of turns currently registered (diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }
}

/** The process-wide registry every chat route + background job shares. */
export const chatCancelRegistry = new ChatCancelRegistry();
