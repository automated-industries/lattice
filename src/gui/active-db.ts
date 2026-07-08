import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import type { EntityContextDefinition } from '../schema/entity-context.js';
import type { LatticeManifest } from '../lifecycle/manifest.js';
import type { RealtimeBroker, RealtimePayload } from './realtime.js';
import type { FillLlm } from '../schema/computed-fill.js';
import type { FeedBus } from './feed.js';
import type { FileLoopbackWatcher } from './file-watcher.js';
import type { RenderProgressBus } from './render-progress.js';
import type { ChatProgressBus } from './chat-progress.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { rowAccessSummaries } from '../cloud/members.js';
import { isInternalNativeEntity } from '../framework/native-entities.js';

/**
 * The active-workspace value object + the small read-side helpers that operate
 * on it (audience-masked read redirect, realtime visibility gate, row-access
 * enrichment, feed-table filtering). Extracted from `server.ts` as the bottom
 * of the GUI module graph: route modules + the request context import FROM here;
 * this file imports nothing route-ish, so it can never participate in an import
 * cycle back through the server / chat loop.
 */

export interface RenderStatusSnapshot {
  /** Coarse lifecycle: idle (never started) → running → done | error. */
  phase: 'idle' | 'running' | 'done' | 'error';
  /** The table currently being rendered, if any. */
  currentTable?: string;
  /** Zero-based index of {@link currentTable} among the entity-context tables. */
  tableIndex?: number;
  /** Total number of entity-context tables in this render. */
  tableCount?: number;
  /** Per-table progress, keyed by table name. */
  tables: Record<
    string,
    { pct: number; entitiesRendered: number; entitiesTotal: number; done: boolean }
  >;
  /** Wall-clock duration of the render, set when it completes. */
  durationMs?: number;
  /** Error text when {@link phase} is `error`. */
  error?: string;
}

export interface ActiveDb {
  configPath: string;
  outputDir: string;
  db: Lattice;
  validTables: Set<string>;
  junctionTables: Set<string>;
  /**
   * Names of the registered computed tables (live, read-only SQL projections
   * from the config's `computed:` section plus any created at runtime).
   * Populated at open from the Lattice instance's registration and kept
   * current by the computed-table ops. Row writes against these are refused
   * with a friendly error before the core refusal fires.
   */
  computedTables: Set<string>;
  /**
   * DISPLAY-only link tables to hide from object lists / sidebars / the Markdown
   * panel: the strict {@link ActiveDb.junctionTables} PLUS physical link tables
   * created without declared relations (e.g. an AI-built `files_<entity>`),
   * classified by column shape via `isHiddenLinkTable`. Never used for any
   * destructive path — purely cosmetic filtering.
   */
  hiddenLinkTables: Set<string>;
  /**
   * Entity contexts registered on the live Lattice — covers both YAML and
   * programmatic `defineEntityContext()` registrations. Tables missing here
   * fall back to {@link ActiveDb.manifest} for row-context discovery.
   */
  entityContextByTable: Map<string, EntityContextDefinition>;
  /**
   * Last-read render manifest. Used as the fallback when a table has no
   * registered {@link EntityContextDefinition} but has rendered context
   * files on disk — typically when the user defines entity contexts in
   * an mjs/ts module the GUI process never imports. Re-read on each
   * `openConfig` so manual `lattice render` runs are picked up the next
   * time the GUI swaps DBs (or on next request via a small cache).
   */
  manifest: LatticeManifest | null;
  softDeletable: Set<string>;
  /**
   * Active LISTEN/NOTIFY broker when the underlying Lattice is backed
   * by Postgres. Null for SQLite (no realtime). Owned by the active
   * DB; replaced wholesale on switch.
   */
  realtime: RealtimeBroker | null;
  /**
   * In-process activity feed for the sidebar. Unlike {@link ActiveDb.realtime}
   * (Postgres-only), this works for every dialect — every audited mutation is
   * published here and streamed to the sidebar as `feed` messages on the
   * multiplexed `/api/stream` WebSocket. Owned by the active DB; replaced
   * wholesale on switch (clients reconnect).
   */
  feed: FeedBus;
  /**
   * File loopback watcher (workspace/autoRender mode only; null otherwise).
   * Captures edits to the rendered tree back into the DB via the changelog path.
   * Started by startBackgroundRender, stopped by disposeActive.
   */
  fileWatcher: FileLoopbackWatcher | null;
  /**
   * Once-guard: true after the broker→re-render subscription is wired (eager
   * per-viewer freshness — a remote change re-renders this member's tree). Set in
   * {@link startBackgroundRender}, which can be called more than once per ActiveDb.
   */
  eagerRenderWired?: boolean;
  /**
   * Tables the open-time cloud converge could not manage (e.g. owned by a
   * different Postgres role). Empty on a clean open. Surfaced via /api/dbconfig so
   * the user gets a specific, actionable message instead of a partial converge.
   */
  convergeWarnings: { table: string; reason: string }[];
  /**
   * Resolves when the owner-side cloud convergence (RLS / grants / native-entity
   * adopt / schema publish) has finished. On a GUI open this convergence runs in
   * the BACKGROUND so the workspace switch returns immediately (the owner is
   * BYPASSRLS, so its own reads/writes/render never depend on convergence — that
   * work is for members joining later + cross-release self-heal). The promise
   * NEVER rejects: a failure is surfaced into {@link convergeWarnings} + logged,
   * not thrown (it runs unawaited). Callers that need a fully-converged cloud
   * before asserting (tests) `await active.converged`; the GUI ignores it.
   */
  converged: Promise<void>;
  /** Original db: connection string from the YAML, used to spin up the broker. */
  dbPath: string;
  /**
   * Workspace mode: canonical entity contexts are auto-derived and every
   * mutation schedules a render. Drives whether a runtime schema creation
   * registers a canonical context inline (so the new table renders without a
   * reopen). False for plain `lattice gui --config x.yml` (manifest-only).
   */
  autoRender: boolean;
  /**
   * Per-table render progress bus for this workspace. The background render
   * publishes {@link RenderProgress} events here; the GUI subscribes via the
   * `render-progress` messages on the multiplexed `/api/stream` WebSocket. Always
   * constructed (even for SQLite / non-autoRender) so the stream has a live
   * target; replaced wholesale on switch.
   */
  renderProgress: RenderProgressBus;
  /**
   * In-process bus for streaming a chat turn's progress to the GUI over the
   * multiplexed `/api/stream` WebSocket — chat text lives HERE, not on a held-open
   * POST response. Carried ACROSS a `reopenSameConfig` (like {@link feed}) so an
   * in-flight chat job + already-connected sockets keep the same bus instance.
   */
  chatProgress: ChatProgressBus;
  /**
   * Per-workspace FIFO for the heavy chat loop: each queued turn's background job
   * chains onto this so a second message runs only after the first finishes
   * (serialized per workspace). Init `Promise.resolve()`; carried across reopen.
   */
  chatJobs: Promise<void>;
  /**
   * Aborts the in-flight background render for this workspace. {@link disposeActive}
   * fires it before closing the DB so the render loop bails before its next query
   * hits a closing adapter. One controller per workspace (single-use).
   */
  renderAbort: AbortController;
  /** Folded snapshot of {@link renderProgress}, served over `/api/render/status`. */
  renderState: RenderStatusSnapshot;
  /**
   * #2.1 — base table → its audience-masking view (`<table>_v`) for the rows a
   * MEMBER must read through. A secured cloud REVOKEs base SELECT from members
   * for any table with a column audience and grants only the masking view, so a
   * member's base read would be `permission denied`; the read path routes those
   * SELECTs to the view (writes still target the base under RLS). Empty for an
   * owner open and for local/SQLite (no masking, base SELECT intact).
   */
  maskedReadViews: Map<string, string>;
  /**
   * Non-blocking, fail-silent hooks (attached by openConfig) that auto-generate
   * column / table definitions via a cheap model when a user creates them.
   * `onColumnsAdded` feeds {@link MutationCtx}; `generateTableDescription` is
   * called by createUserEntity. No-op without Claude auth.
   */
  onColumnsAdded?: (table: string, columns: string[]) => void;
  /** Auto-repairs dashboards after breaking model changes; disposed with the workspace. */
  dashboardRepair?: { dispose: () => void };
  generateTableDescription?: (table: string, columns: string[]) => void;
  /**
   * Builds the model adapter the computed-table AI fill runs with (attached by
   * openConfig; the real adapter resolves Claude auth per call and reports
   * "not configured" through the fill engine's per-field error state, so no
   * auth is required to attach it). Tests substitute a fake to drive fills
   * deterministically.
   */
  computedFillLlm?: () => FillLlm;
}

/**
 * Should a realtime change envelope be forwarded to the role THIS server is
 * connected as? The NOTIFY fan-out is global (every change on the whole cloud), so
 * this gate scopes it per recipient — without it a member's realtime/feed stream
 * would disclose the pk + existence of rows the member cannot read. For an
 * `upsert` we probe the live row's visibility through the SAME SECURITY-DEFINER
 * predicate RLS uses (keyed on `session_user` = this connection's role), so the
 * filter is inherently per-recipient. For a `delete` the live row + its ownership
 * record are already gone, so we probe the PRE-DELETE visibility snapshot the
 * delete trigger captured (carried on the payload) through the parallel snapshot
 * predicate — the same per-recipient decision. No-op (always visible) on a
 * non-cloud single-user SQLite DB. Fails CLOSED (don't forward) on a probe error
 * or a missing snapshot, logging it.
 */
export async function changeVisibleToActiveRole(
  db: Lattice,
  payload: RealtimePayload,
): Promise<boolean> {
  if (db.getDialect() !== 'postgres') return true; // single-user local — nothing to gate
  if (!payload.table_name || !payload.pk) return false;
  try {
    if (isDeleteOp(payload.op)) {
      // No snapshot (a legacy delete emitted before the snapshot columns) → fail
      // closed: a delete event must never be forwarded unproven.
      if (payload.del_owner_role == null) return false;
      const row = (await getAsyncOrSync(
        db.adapter,
        `SELECT lattice_delete_visible(?, ?, ?::text[]) AS v`,
        [payload.del_owner_role, payload.del_visibility ?? null, payload.del_grantees ?? []],
      )) as { v?: unknown } | undefined;
      return row?.v === true || row?.v === 't' || row?.v === 1;
    }
    const row = (await getAsyncOrSync(db.adapter, `SELECT lattice_row_visible(?, ?) AS v`, [
      payload.table_name,
      payload.pk,
    ])) as { v?: unknown } | undefined;
    return row?.v === true || row?.v === 't' || row?.v === 1;
  } catch (e) {
    console.warn('[realtime] visibility probe failed (dropping change):', (e as Error).message);
    return false;
  }
}

/** True for a delete op (which can't be visibility-probed post-hoc). */
export function isDeleteOp(op: string): boolean {
  return op === 'delete' || op === 'DELETE';
}

/**
 * Internal plumbing tables (the assistant's own chat storage + every `_lattice*`
 * bookkeeping table) are NOT user activity — they must never surface as feed
 * pills. files/secrets/notes etc. stay visible. Shared by the multiplexed event
 * stream's two feed sources (the local feed bus + the cloud broker merge).
 */
export function isFeedHiddenTable(t: string): boolean {
  return t.startsWith('_lattice') || t.startsWith('__lattice') || isInternalNativeEntity(t);
}

/**
 * #2.1 — the relation a SELECT for `table` should target: the audience-masking
 * view (`<table>_v`) when this (member) connection lost base SELECT, else the base
 * table itself. Passing `<table>_v` to `db.query`/`db.get`-style SELECTs is safe —
 * the view is unregistered (column validation passes through) so it never appears
 * as a sidebar entity, and the view re-applies row visibility + cell masking. Only
 * reads route here; writes always target the base table under RLS.
 */
export function readRelationFor(active: ActiveDb, table: string): string {
  return active.maskedReadViews.get(table) ?? table;
}

/**
 * Attach a per-row `_access` summary (visibility + ownedByMe [+ grantees]) onto
 * each row so the GUI's sharing affordance renders. The frontend hides the share
 * UI when `_access` is absent, so this is what makes cloud sharing visible again
 * (the 3.0 RLS rewrite dropped the old enrichment without a replacement). No-op
 * off a secured cloud. Each row's key is its canonical pk string (single = bare
 * value, composite = TAB-joined), matching `__lattice_owners.pk`.
 */
export async function attachRowAccess(db: Lattice, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const pkCols = db.getPrimaryKey(table);
  if (pkCols.length === 0) return;
  const pkOf = (r: Row): string => pkCols.map((c) => String(r[c])).join('\t');
  const summaries = await rowAccessSummaries(db, table, rows.map(pkOf));
  if (summaries.size === 0) return;
  for (const r of rows) {
    const a = summaries.get(pkOf(r));
    if (a) (r as Row & { _access?: unknown })._access = a;
  }
}
