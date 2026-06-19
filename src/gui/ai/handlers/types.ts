import type { Lattice } from '../../../lattice.js';
import type { FeedBus } from '../../feed.js';
import type { MutationCtx } from '../../mutations.js';
import type { FetchBudget } from '../../../ai/fetch-policy.js';
import type { DeleteResolution, DeleteEntityOutcome } from '../../schema-ops.js';

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
