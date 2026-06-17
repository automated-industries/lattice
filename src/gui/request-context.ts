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
