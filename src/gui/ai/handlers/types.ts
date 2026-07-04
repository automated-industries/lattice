import type { Lattice } from '../../../lattice.js';
import type { FeedBus } from '../../feed.js';
import type { MutationCtx } from '../../mutations.js';
import type { FetchBudget } from '../../../ai/fetch-policy.js';
import type { DeleteResolution, DeleteEntityOutcome } from '../../schema-ops.js';
import type { ComputedTableDef } from '../../../config/types.js';
import type { ComputedPreview } from '../../computed-ops.js';
import type { FieldFillResult } from '../../../schema/computed-fill.js';

/**
 * Native tables the assistant must NEVER read, write, or be told about. The
 * chat route strips these from the callable `validTables`, the schema context
 * omits them, and `list_entities` skips them — so the model neither sees them
 * nor can target them (read OR write).
 *
 * - `secrets`: holds decrypted API keys / OAuth tokens; the dispatcher reads
 *   rows already-decrypted, so a request (or instructions injected via an
 *   attached file's `extracted_text`) could otherwise spill credentials.
 * - `chat_threads` / `chat_messages`: the assistant's OWN conversation storage.
 *   Letting the model `delete_row`/`update_row` here would let a prompt
 *   injection erase or rewrite chat history. Persistence writes go through
 *   `db.insert` directly (not the dispatcher), so hiding them here is safe.
 */
export const ASSISTANT_HIDDEN_TABLES: ReadonlySet<string> = new Set([
  'secrets',
  'chat_threads',
  'chat_messages',
]);

/** A junction the assistant created (or that already existed) for `link`. */
export interface AssistantJunction {
  junction: string;
  tableA: string;
  aFk: string;
  tableB: string;
  bFk: string;
}

/**
 * The computed-table operations the assistant's computed tools run through —
 * the same audited, revertible, no-reopen primitives behind the GUI's
 * computed-table builder routes. Injected by the server as closures over the
 * active workspace (mirroring `createEntity` and friends below); absent → the
 * computed-table tools report they're unavailable.
 */
export interface ComputedOps {
  /** Current computed-table definitions, in declaration order. */
  list(): Promise<{ name: string; def: ComputedTableDef }[]>;
  /** Dry-run a definition: compile + run with a row cap. No DDL, no persist. */
  preview(def: ComputedTableDef, limit?: number): Promise<ComputedPreview>;
  create(name: string, def: ComputedTableDef): Promise<void>;
  update(name: string, def: ComputedTableDef): Promise<void>;
  /** Run the AI fill for the table's AI fields (aliases/calcs are always live). */
  refresh(name: string): Promise<FieldFillResult[]>;
  /** Drop the definition (refused while other computed tables are built on it). */
  delete(name: string): Promise<void>;
}

export interface DispatchCtx {
  db: Lattice;
  feed: FeedBus;
  /**
   * "Private mode" (a chat-composer toggle): when true, rows the assistant creates
   * this turn are forced PRIVATE regardless of the table's default visibility — a
   * transient per-action choice, applied by calling the existing owner-only
   * `set_row_visibility` after create (the creator owns the new row). Off ⇒ new
   * rows follow the table default. Cloud (Postgres) only.
   */
  privateMode?: boolean;
  /** Allowlist of queryable/writable user tables (mirrors the HTTP gate). */
  validTables: Set<string>;
  /** Junction tables eligible for link/unlink. */
  junctionTables: Set<string>;
  /**
   * Names of the registered computed tables (live, read-only projections).
   * Used to tag them in the schema context and `list_entities` (so the model
   * never targets one with a row write) and to route `delete_entity` on a
   * computed name to the definition delete. Absent → treated as empty.
   */
  computedTables?: Set<string>;
  /** Tables carrying a `deleted_at` column. */
  softDeletable: Set<string>;
  /**
   * Fired (un-awaited) when an AI write auto-adds columns, so new columns get a
   * generated definition. Supplied by the chat route; absent → no generation.
   */
  onColumnsAdded?: (table: string, columns: string[]) => void;
  /** Active config path + rendered-context dir, for the `dedup` tool's link re-pointing. */
  configPath?: string;
  outputDir?: string;
  /** Inference aggressiveness 0..1 — sets how liberal the `dedup` tool's fuzzy matching is. */
  aggressiveness?: number;
  /**
   * The GUI session that initiated this chat turn. Stamped on the assistant's
   * mutations so they share the user's session-scoped undo/redo stack — the user
   * can undo what they asked the assistant to do.
   */
  sessionId?: string;
  /**
   * Create a new entity (table) with inferred columns — audited + reversible,
   * no DB reopen (defineLate). Supplied by the server when schema creation is
   * allowed; absent → `create_entity` reports it's unavailable. Returns the
   * created table name, or null when it can't be created.
   */
  createEntity?: (name: string, columns: string[]) => Promise<string | null>;
  /**
   * Add a column to an existing user table — audited + reversible, no reopen
   * (defineLate). Absent → `add_column` reports it's unavailable. Returns the
   * created column name on success, or an error string.
   */
  addColumn?: (
    table: string,
    column: string,
  ) => Promise<{ ok: true; column: string } | { ok: false; error: string }>;
  /**
   * Create (or return) a many-to-many junction between two existing tables —
   * audited + reversible, no reopen. Absent → `create_relationship` reports it's
   * unavailable. Returns the junction + its two foreign-key columns, or null.
   */
  createJunction?: (tableA: string, tableB: string) => Promise<AssistantJunction | null>;
  /**
   * Soft-delete a user table — guarded + reversible (no physical drop). Supplied
   * by the server; absent → `delete_entity` reports it's unavailable. An EMPTY
   * table is deleted immediately; a NON-empty table returns `needsResolution` so
   * the assistant asks the user, then re-calls with a resolution.
   */
  deleteEntity?: (name: string, resolution?: DeleteResolution) => Promise<DeleteEntityOutcome>;
  /**
   * Computed-table primitives (list / preview / create / update / refresh /
   * delete) — audited + revertible, no reopen. Supplied by the server; absent →
   * the computed-table tools report they're unavailable.
   */
  computedOps?: ComputedOps;
  /**
   * Author or edit a complete standalone HTML file via a focused model sub-call
   * (a stronger model than the chat default). Supplied by the chat route, closed
   * over the resolved Claude auth + this turn's schema. Absent → the
   * `create_dashboard` / `edit_dashboard` tools report they're unavailable (fail
   * loud, never silent). `currentHtml` is passed when editing an existing page.
   */
  htmlAuthor?: (spec: string, currentHtml?: string) => Promise<string>;
  /**
   * The id of the dashboard the user is currently viewing (resolved from
   * `activeContext` when that row is a dashboards row), so `edit_dashboard` edits
   * the one on screen when the user doesn't name one. Absent → the edit tool
   * requires an explicit id.
   */
  activeDashboardId?: string;
  /**
   * The current turn's user message text. `ingest_url` only fetches a URL that
   * literally appears here — so the model can't be talked into fetching a URL it
   * found inside a file/row (an SSRF + injection vector). Absent → no URL passes.
   */
  userMessage?: string;
  /**
   * Per-chat-turn fetch budget shared across every `ingest_url` call this turn,
   * so a single message can't trigger an unbounded number of fetches. The chat
   * route creates one per turn; absent → a fresh per-call budget (tests).
   */
  urlFetchBudget?: FetchBudget;
}

export interface DispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * The arguments every group handler receives. The SAME `ctx` reference is
 * threaded to every group (never a copy) so in-place mutations of
 * `ctx.validTables` / `ctx.junctionTables` by create_entity / add_column /
 * create_relationship / delete_entity stay visible to later cases this turn.
 */
export interface HandlerDeps {
  ctx: DispatchCtx;
  mctx: MutationCtx;
  name: string;
  args: Record<string, unknown>;
}

/** Sentinel returned by a group handler when it owns no case matching `name`. */
export const NOT_HANDLED = Symbol('handler-not-matched');

/** A group handler returns a real result, or the NOT_HANDLED sentinel. */
export type GroupResult = DispatchResult | typeof NOT_HANDLED;
