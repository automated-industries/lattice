import type { ActiveDb } from './active-db.js';
import type { FeedSource } from './feed.js';
import type { MutationCtx } from './mutations.js';

/**
 * Per-request mutation-context construction, extracted from server.ts. The GUI
 * request handler builds a {@link MutationCtx} at several sites (row CRUD, link/
 * unlink, schema, history); they had drifted — some included `onColumnsAdded` /
 * `clientTs`, some didn't. {@link buildMutationCtx} is the single canonical
 * builder so every write carries the same base context. It is a pure leaf (no
 * HTTP / server import), so route modules + the request handler import FROM here
 * and it can never cycle back through the server.
 *
 * Schema-op handlers additionally attach `applySchemaInverse` / `applySchemaForward`
 * (closures over the server's reassignable `active`); they spread the result of
 * this builder and add those two hooks, so the base stays canonical here.
 */

export interface BuildMutationCtxOptions {
  /**
   * The originating client's true edit time (`x-lattice-client-ts`), honored for
   * the audit/history timestamp so an OFFLINE edit replayed later shows when it
   * was made, not when it synced. Pass the raw header value (may be undefined);
   * when the key is supplied the resulting ctx carries `clientTs`, matching the
   * row-CRUD path. Omit entirely for callers that never set it (link/unlink).
   */
  clientTs?: string | undefined;
}

/**
 * Build the canonical {@link MutationCtx} for a write against `active`. Always
 * carries db / feed / softDeletable / source / sessionId, and folds in the
 * active workspace's `onColumnsAdded` auto-column hook when present (inert for
 * writes that never add columns, e.g. link/unlink). `clientTs` is included only
 * when the caller supplies the option key — preserving the prior per-site shape.
 */
export function buildMutationCtx(
  active: ActiveDb,
  source: FeedSource,
  sessionId: string,
  opts: BuildMutationCtxOptions = {},
): MutationCtx {
  const ctx: MutationCtx = {
    db: active.db,
    feed: active.feed,
    softDeletable: active.softDeletable,
    source,
    sessionId,
    ...(active.onColumnsAdded ? { onColumnsAdded: active.onColumnsAdded } : {}),
  };
  if ('clientTs' in opts) ctx.clientTs = opts.clientTs;
  return ctx;
}

/**
 * Getter/setter callbacks supplied by startGuiServer so the factory can close
 * over the handler's reassignable `let`s. A `let` cannot be passed by reference,
 * so each binding is exposed as a get/set pair. The factory NEVER captures the
 * values — only these accessors — so reads always see the live value and writes
 * go back through the SAME binding the handler (and its existing `setActive`
 * helper + inline `active = activeRef = …` swaps) already use.
 */
export interface GuiRequestContextBindings {
  /** Reads the outer-closure `activeRef`. Never null past the virgin guard. */
  getActiveRef: () => ActiveDb | null;
  /** Writes the outer-closure `activeRef` — the same store `setActive` writes. */
  setActiveRef: (next: ActiveDb | null) => void;
  /** Writes the per-request `active` local so the REST of this request sees the swap. */
  setLocalActive: (next: ActiveDb) => void;
  /** Reads the served-workspace id (header label). */
  getWorkspaceId: () => string | null;
  /** Writes the served-workspace id — the same store `setActive` writes. */
  setWorkspaceId: (next: string | null) => void;
  /** Fires the off-response-path render after a swap (startBackgroundRender). */
  startBackgroundRender: (active: ActiveDb) => void;
  /** Per-process audit session id (immutable for the server's lifetime). */
  sessionId: string;
}

/**
 * Per-request handle the route modules (read / tables / schema / history /
 * workspaces / databases) take as their third argument `(req, res, ctx)`.
 *
 * `active()` ALWAYS returns the CURRENT active workspace — even after a
 * mid-handler swap — because it reads the live `activeRef` binding through the
 * getter rather than capturing a value. `swapActive` is the single write-back
 * path: it updates `activeRef`, the per-request `active` local, and (optionally)
 * the served-workspace id in lockstep, then kicks the background render —
 * exactly what the inline `active = activeRef = next; currentWorkspaceId = id;
 * startBackgroundRender(next)` swaps do today.
 *
 * `swapActive`'s second parameter is optional by tuple-length, not by value:
 * omitting it (schema-op / dbconfig reopen, database-config switch) leaves the
 * header label untouched; passing it — including passing `null` — moves the
 * label (workspace routes).
 */
export interface GuiRequestContext {
  /** The live active DB for THIS request. Non-null (established past the virgin guard). */
  active(): ActiveDb;
  /** Per-process audit session id. */
  readonly sessionId: string;
  /** Live served-workspace id (drives the header label). */
  workspaceId(): string | null;
  /**
   * The single active-DB swap primitive for route handlers. Reassigns the outer
   * `activeRef` AND the per-request `active` local in lockstep, kicks the
   * background render, and updates the served-workspace id ONLY when the
   * `workspaceId` argument is actually supplied. Omit it (same-workspace reopens)
   * to leave the label untouched; pass string|null (workspace routes) to also
   * move it — passing `null` is a real "no label" write, distinct from omission.
   */
  swapActive(next: ActiveDb, workspaceId?: string | null): void;
  /**
   * Transition to the virgin (zero-workspace) state: clears the active DB and the
   * served-workspace id to null. The inverse of {@link swapActive}, used when the
   * LAST workspace is deleted — the next request then hits server.ts's virgin
   * guard and serves the welcome screen. The caller disposes the old active DB
   * first; the per-request `active` local is left stale (the caller makes no
   * further use of it this request).
   */
  goVirgin(): void;
  /** Build the canonical MutationCtx for a write against the CURRENT active DB. */
  buildMutationCtx(opts?: BuildMutationCtxOptions): MutationCtx;
}

/**
 * Build the per-request {@link GuiRequestContext}. Called once per request, right
 * after the virgin guard establishes a non-null active DB. It closes over the
 * `bindings` getters/setters — NOT over any DB value — so `active()` re-reads
 * `getActiveRef()` every call (always current, even after a `swapActive` earlier
 * in the same request) and `swapActive` writes back through the SAME bindings the
 * existing inline swaps write. `active()` asserts non-null with a loud throw (the
 * caller is contractually past the virgin guard, so null is a real invariant
 * violation, never a silent default). `swapActive` uses a REST TUPLE — not
 * `arguments` (unbound in arrows) — so it can distinguish "omitted" from "passed
 * null".
 */
export function createGuiRequestContext(bindings: GuiRequestContextBindings): GuiRequestContext {
  const {
    getActiveRef,
    setActiveRef,
    setLocalActive,
    getWorkspaceId,
    setWorkspaceId,
    startBackgroundRender,
    sessionId,
  } = bindings;

  const active = (): ActiveDb => {
    const a = getActiveRef();
    if (!a) throw new Error('GuiRequestContext.active() called with no active workspace');
    return a;
  };

  return {
    sessionId,
    active,
    workspaceId: () => getWorkspaceId(),
    swapActive(next: ActiveDb, ...rest: [workspaceId?: string | null]): void {
      setActiveRef(next);
      setLocalActive(next);
      if (rest.length > 0) setWorkspaceId(rest[0] ?? null);
      startBackgroundRender(next);
    },
    goVirgin(): void {
      setActiveRef(null);
      setWorkspaceId(null);
    },
    buildMutationCtx: (opts: BuildMutationCtxOptions = {}) =>
      buildMutationCtx(active(), 'gui', sessionId, opts),
  };
}
