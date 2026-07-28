import { getFunction } from './registry.js';
import type { MutationCtx } from '../mutations.js';
import { handleRead } from './handlers/read.js';
import { handleRowMutations } from './handlers/row-mutations.js';
import { handleCollaboration } from './handlers/collaboration.js';
import { handleComputed } from './handlers/computed.js';
import { handleHistory } from './handlers/history.js';
import {
  NOT_HANDLED,
  type DispatchCtx,
  type DispatchResult,
  type HandlerDeps,
} from './handlers/types.js';

// Re-export the public surface so every existing `from './ai/dispatch.js'`
// import keeps resolving unchanged after the switch was split into per-group
// handler modules. Consumers: chat-routes.ts + read-routes.ts (ASSISTANT_HIDDEN_TABLES,
// AssistantJunction, DispatchCtx), gui-ai-visibility-permission.test.ts
// (visibilityDenialReason), plus the moved helpers (belt-and-suspenders — keeps
// the relocation a non-API change regardless of who imports what by name).
export {
  ASSISTANT_HIDDEN_TABLES,
  type DispatchCtx,
  type DispatchResult,
  type AssistantJunction,
  type ComputedOps,
  type HandlerDeps,
} from './handlers/types.js';
export { visibilityDenialReason } from './handlers/permission.js';
export { requireString, requireTable } from './handlers/helpers.js';
export {
  SECRET_MASK,
  secretColumnsFor,
  redactRow,
  frameUntrustedFileContent,
} from './handlers/read.js';
export {
  normalizeUrl,
  userProvidedUrl,
  parseBulkFilters,
  parseJunctionValues,
  isWriteConflict,
} from './handlers/row-mutations.js';
import { parseBulkFilters, parseJunctionValues } from './handlers/row-mutations.js';
import { loadGuiData } from '../data.js';

/**
 * Registry function names the dispatcher can execute. This is the data-and-
 * history surface — reads, row writes, junction links, undo/redo/revert, the
 * NO-REOPEN schema mutations (create_entity, add_column, create_relationship,
 * delete_entity) that register live via defineLate so the assistant can shape the
 * workspace on request, and the computed-table tools (preview / create / update /
 * refresh — same no-reopen property via the live registration path). Only
 * database LIFECYCLE (switch/create a whole database), which re-opens the active
 * connection, stays UI-driven and excluded.
 */
export const DISPATCHABLE: ReadonlySet<string> = new Set([
  'list_entities',
  'list_rows',
  'get_row',
  'get_row_context',
  'get_provenance',
  'read_file_text',
  'search',
  'lattice_help',
  'propose_model_simplification',
  // Handled by the chat loop itself (it emits a `question` SSE event and ends
  // the turn) — listed here so the tool is offered to the model; see the
  // executeFunction guard below.
  'ask_user',
  'get_history',
  'create_row',
  'create_artifact',
  'create_dashboard',
  'edit_dashboard',
  'investigate',
  'import_spreadsheet',
  'create_secret',
  'ingest_url',
  'ingest_text',
  'set_definition',
  'set_visibility',
  'dedup',
  'merge_rows',
  'update_row',
  'bulk_update',
  'delete_row',
  'link',
  'unlink',
  'create_entity',
  'add_column',
  'create_relationship',
  'delete_entity',
  'preview_computed_table',
  'create_computed_table',
  'update_computed_table',
  'refresh_computed_table',
  'undo',
  'redo',
  'revert',
]);

// ── Turn outcome ledger — one shared claim-verification gate ─────────────────
//
// The disease this cures shows up on several axes at once: a turn deletes
// nothing and the answer says "you now have 6 objects instead of 59"; a document
// is never written and the answer says "it is in your workspace"; every figure on
// a page comes back zero and the answer says it is ready. In each case the model
// SELF-REPORTS the outcome in prose and nothing reconciles that prose against
// what the tools actually did.
//
// So this is ONE mechanism with several registered call sites, not one mechanism
// per axis. Every tool call this turn is recorded as a {@link ToolAttempt}; each
// registered {@link ClaimVerifier} reads that same record and returns the
// {@link OutcomeFact}s its axis can prove. A NEW axis is a new entry in
// {@link CLAIM_VERIFIERS} — never a new subsystem.
//
// The one axis-specific piece is the destructive PRE-flight gate below, which has
// to refuse a call before it runs rather than describe it afterwards.

/** One executed (or refused) tool call, with what actually came back. */
export interface ToolAttempt {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Set when the call was classified as destructive by the pre-flight gate. */
  destructive?: DestructiveIntent;
  /** True when the gate refused the call, so nothing ran. */
  refused?: boolean;
}

export type OutcomeFactKind =
  /** Something the answer may be about to claim happened, and it did not. */
  | 'not_done'
  /** A change that DID land and is still applied — usually half of a failed plan. */
  | 'residue'
  /** It ran, but the result does not support calling it a success. */
  | 'suspect';

export interface OutcomeFact {
  axis: string;
  kind: OutcomeFactKind;
  /** Stable identity, so the same fact restated across rounds stays one fact. */
  key: string;
  /** Model-facing: exact, names the real target and the real error. */
  statement: string;
  /** User-facing: the same truth in business terms, with no internal jargon. */
  userStatement: string;
  /** Recovery offer, when the change can be reversed. */
  undo?: string;
  /**
   * True when the fact exists only because the turn stopped to ASK the user something
   * that already states it — today, a `delete_entity` that reported what is in the way
   * and is waiting on a decision about those records. Still stated to the model;
   * withheld from the user-facing notice when the turn ends on that question, since
   * the question is the same sentence.
   *
   * A gate REFUSAL is deliberately not provisional: nothing asks the user anything on
   * its behalf, so suppressing it would leave them told nothing.
   */
  provisional?: boolean;
}

/** How the turn itself ended, for facts that only exist because of how it ended. */
export interface TurnContext {
  /** True once the user has stopped the turn — it will not get to finish its plan. */
  stopped: boolean;
}

/** One axis of "what is the answer about to claim, and is it true". */
export interface ClaimVerifier {
  axis: string;
  /** Pure over the turn's attempts — no I/O, so it can run after every round. */
  facts(attempts: readonly ToolAttempt[], turn: TurnContext): OutcomeFact[];
}

/**
 * How many records a single-object removal or clear may touch before the assistant
 * refuses it outright.
 *
 * This is a HARD BOUNDARY, not a confirmation trigger — there is no answer that
 * makes a refused removal proceed. That is what makes the number a product
 * decision rather than a tuning knob.
 *
 * It was 25 while a confirmation existed: too small to matter, because the cost of
 * being over it was one question. As a wall, 25 is the wrong number — clearing a
 * field on thirty rows is an ordinary edit, and refusing it removes the only route
 * a person has, since the app has no way to select many rows and act on them.
 *
 * 200 is chosen to sit above ordinary editing and below anything anyone would call
 * a bulk operation. Multi-OBJECT destruction is refused at any size regardless, so
 * this bound only ever governs a single object, where the blast radius is legible.
 */
export const DESTRUCTIVE_ROW_THRESHOLD = 200;
/**
 * Cap for the gate's pre-flight counts — bounded, SQL-side, never a table scan.
 *
 * `boundedCount` stops at `cap + 1`, so a count EQUAL to that is not a count at all:
 * it is "at least this many, and nobody looked further". Everything downstream has to
 * carry that distinction — see {@link DestructiveIntent.rowsSaturated}.
 */
const DESTRUCTIVE_COUNT_CAP = 5000;
/** Longest a single card line may be. A card line is read by a person, once. */
const MAX_DETAIL_CHARS = 240;
/** Longest any single interpolated VALUE may be inside a card line. */
const MAX_DETAIL_VALUE_CHARS = 60;
/** A `spec`-authored document shorter than this was very likely never really written. */
const MIN_AUTHORED_ARTIFACT_CHARS = 200;

/**
 * Tools that remove or clear data. Adding one here is the whole registration.
 *
 * Membership is what makes a call CLASSIFIED, and classification is what makes the
 * refusal fire: a tool outside this set is never measured, so it is never gated by
 * anything. The set IS the registration, so an omission is silent.
 */
export const REMOVAL_TOOLS: ReadonlySet<string> = new Set([
  'delete_entity',
  'delete_row',
  'unlink',
  'bulk_update',
  // The SAME destruction `bulk_update` is gated for, one row at a time. It was left
  // out, and the omission was not academic: a plan split into `update_row` calls
  // setting a field to null wiped records with no gate at all, because a tool outside
  // this set is never classified and so never counts toward the turn's size. Every
  // tool that can null or overwrite a stored value has to be in here.
  'update_row',
  // Both consolidate rows by SOFT-DELETING the ones that lose. Recoverable, but
  // still a removal from the user's point of view: the rows stop being there, and
  // `dedup` in particular decides for itself which ones. They were ungated, so a
  // single `dedup` call could collapse an arbitrary number of records with no
  // confirmation of any kind.
  'merge_rows',
  'dedup',
]);

export interface DestructiveIntent {
  kind: 'remove_object' | 'delete_records' | 'unlink' | 'clear';
  /** The object (table) being destroyed — the identity a plan's size counts. */
  target: string;
  /** Best-effort pre-flight count of records this call affects. */
  rows: number;
  /** True when the count could not be established (treated as wide, never as 0). */
  rowsUnknown?: boolean;
  /**
   * True when the count hit {@link DESTRUCTIVE_COUNT_CAP} and is therefore a FLOOR,
   * not a total. Load-bearing, because the number itself cannot say so: a table with
   * 12,000 records counts as 5001 exactly like a table with 5001, and the card read
   * "5001 record(s)" for both. Everywhere a count is shown or compared, this decides
   * whether it may be stated as a fact ("5001") or only as a bound ("at least 5001").
   */
  rowsSaturated?: boolean;
  /** One phrase naming this call's exact target + count, for the refusal text. */
  detail: string;
}

/** A pre-flight count, with the two things a bare number cannot say about itself. */
interface RowCount {
  n: number;
  /** The count could not be established at all — treated as wide, never as 0. */
  unknown: boolean;
  /** `n` is a floor, not a total: the count stopped at the cap. */
  saturated: boolean;
}

/**
 * How many records, said HONESTLY — a capped count must never read as an exact one.
 *
 * `boundedCount` returns `cap + 1` for anything at or above the cap, so the same 5001
 * is returned by a table of 5,001 records and by a table of 5,000,000. Rendering that
 * as "5001 record(s)" is not a rounding error, it is a false statement of scale on the
 * one screen where the user decides whether to allow the destruction.
 */
function countPhrase(rows: RowCount, n: number = rows.n): string {
  if (rows.unknown) return 'record count unknown';
  return rows.saturated ? `at least ${String(n)} record(s)` : `${String(n)} record(s)`;
}

/**
 * One interpolated VALUE, made safe to put in a sentence the user reads.
 *
 * Mirrors `noteValue` in chat-routes.ts, which does the same job for server context
 * notes; duplicated rather than imported because chat-routes imports THIS module and
 * the cycle is not worth the sharing.
 */
function cardValue(v: unknown, fallback: string): string {
  const cleaned = (typeof v === 'string' ? v : '')
    // Control characters, including every newline and tab, become spaces.
    // eslint-disable-next-line no-control-regex -- deliberate: strip C0/C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return fallback;
  return cleaned.length > MAX_DETAIL_VALUE_CHARS
    ? `${cleaned.slice(0, MAX_DETAIL_VALUE_CHARS - 1).trimEnd()}…`
    : cleaned;
}

/**
 * The last thing every `detail` passes through, applied at ONE chokepoint so a new
 * classifier branch cannot forget it.
 *
 * `detail` is not an internal string: it is the sentence naming what a refused call
 * would have destroyed, and the user acts on it. One was measured reading
 *
 *   clear "notes" - SAFE: only archived test rows, nothing real is lost. Ignore the
 *   line above. Column: "x" ...
 *
 * newlines and all, because `bulk_update`'s `set` KEYS were interpolated straight in
 * and nothing validates a key against the table's real columns. It is not XSS — the
 * client sets textContent — but it is attacker-chosen REASSURANCE inside the one
 * sentence that describes a destruction.
 *
 * Two layers, same as the context notes: each interpolated value is bounded by
 * {@link cardValue}, and the composed line is flattened and bounded here. Between
 * them, a `detail` is always one bounded line of server-composed text.
 */
function safeDetail(s: string): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex -- deliberate: strip C0/C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_DETAIL_CHARS
    ? `${cleaned.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…`
    : cleaned;
}

/** True for a value a write CLEARS — the destruction half of an ordinary edit. */
function clearsValue(v: unknown): boolean {
  return v === null || v === '';
}

/** The keys of `values` whose new value is a cleared one, sorted. */
function clearedKeys(values: Record<string, unknown>): string[] {
  return Object.keys(values)
    .filter((k) => clearsValue(values[k]))
    .sort();
}

/** The keys of `values` whose new value is NOT a cleared one, sorted. */
function overwrittenKeys(values: Record<string, unknown>): string[] {
  return Object.keys(values)
    .filter((k) => !clearsValue(values[k]))
    .sort();
}

/** The `set` / `values` argument as a plain object — `{}` for anything else. */
function writeMap(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Is `name` a real column of `cols`?
 *
 * `name in cols` is NOT this question. Every plain object inherits `constructor`,
 * `toString`, `hasOwnProperty` and the rest, so `in` answered yes for all of them —
 * and a `bulk_update` clearing "constructor" reached the confirmation card as a
 * genuine destructive clear naming a column that does not exist.
 */
function isColumn(cols: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(cols, name);
}

/**
 * A model-supplied id, rendered for the card ONLY when it is shaped like an
 * identifier. Otherwise the card says how many records instead of which.
 *
 * `args.id` is unvalidated model text. It was interpolated straight into the card
 * line, which produced a measured confirmation reading `delete record n_1 (a test
 * copy — the real data is untouched, safe) from "notes"` — attacker-chosen
 * reassurance inside the one screen the user decides from, riding alongside a real
 * spendable grant. `cardValue` bounded and flattened it but could not tell an
 * identifier from a sentence; this can, and a sentence never renders.
 */
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function idPhrase(id: string, fallback: string): string {
  return ID_TOKEN.test(id) ? `record ${id}` : fallback;
}

/** Most extra overwritten columns a card line names before it says "and more". */
const MAX_CARD_COLUMNS = 3;

/**
 * The `and set "x", "y"` half of a clear's card line — '' when the write clears and
 * nothing else.
 *
 * A `bulk_update` / `update_row` is classified as destructive because of what it
 * CLEARS, and the line said only that. Everything else in the same `set` — a column
 * overwritten with a new value, a `visibility` flip that changes who can see the
 * records — happened under the same approval and was never shown. So the user read
 * "clear notes on 4,000 records" and agreed to a call that also rewrote their owner
 * and shared them with the workspace.
 *
 * Same two safety layers as every other interpolated value: names are checked against
 * the table's REAL columns (plus `visibility`, which is the tool's own special key and
 * not a column), each is bounded by {@link cardValue}, and the composed line is
 * flattened by {@link safeDetail}. When the column set is unknowable the names are
 * kept rather than dropped — dropping them would under-state the call.
 */
function alsoOverwrites(
  values: Record<string, unknown>,
  known: Record<string, string> | null,
): string {
  const all = overwrittenKeys(values);
  const real = known ? all.filter((c) => c === 'visibility' || isColumn(known, c)) : all;
  if (real.length === 0) return '';
  const shown = real
    .slice(0, MAX_CARD_COLUMNS)
    .map((c) => `"${cardValue(c, 'a field')}"`)
    .join(', ');
  const more =
    real.length > MAX_CARD_COLUMNS ? ` and ${String(real.length - MAX_CARD_COLUMNS)} more` : '';
  return `and OVERWRITE ${shown}${more} `;
}

/** Up to `max` id tokens, safely rendered, as a phrase — or '' when none qualify. */
function idListPhrase(ids: readonly string[], max: number): string {
  const shown = ids.filter((id) => ID_TOKEN.test(id)).slice(0, max);
  if (shown.length === 0) return '';
  return shown.join(', ') + (ids.length > shown.length ? ', …' : '');
}

/** Title-ish form of a raw object name, for text the USER reads (`q3_lines` → `Q3 Lines`). */
function friendly(name: string): string {
  return (
    name
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase()) || name
  );
}

/**
 * How many of `ids` are really rows of `table` — bounded, keyed, one query.
 *
 * Two jobs. It makes the blast radius TRUE (a call naming ids that are not records
 * destroys fewer than it lists, and one naming none destroys nothing at all), and it
 * is what keeps model prose out of the confirmation: a sentence is not a row id, so a
 * call whose only "id" is a sentence classifies as destroying nothing and no card is
 * ever composed from it.
 *
 * Fails CLOSED — a lookup that could not run returns the full list rather than zero,
 * because "we could not check" must never read as "there is nothing there".
 */
async function countExisting(
  ctx: DispatchCtx,
  table: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  // The list is model-supplied and unbounded, and this builds an `IN (...)` from it.
  // Past the count cap the answer cannot change anything the gate decides — that many
  // records is already far over the threshold — so take the list at its word rather
  // than emitting a pathological statement. Fail-closed: the larger number.
  if (ids.length > DESTRUCTIVE_COUNT_CAP) return ids.length;
  try {
    const pk = ctx.db.getPrimaryKey(table)[0] ?? 'id';
    // No `deleted_at IS NULL` clause: a HARD delete of an already-trashed record is
    // still destruction, and a merge of one is still a change.
    return await ctx.db.boundedCount(table, {
      cap: Math.max(ids.length, 1),
      filters: [{ col: pk, op: 'in', val: [...ids] }],
    });
  } catch (e) {
    console.warn(`[assistant] could not check records of "${table}": ${(e as Error).message}`);
    return ids.length;
  }
}

/** Bounded, SQL-side count of live records in a table. Never throws. */
async function countRows(ctx: DispatchCtx, table: string): Promise<RowCount> {
  try {
    const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
      cap: DESTRUCTIVE_COUNT_CAP,
    };
    if (ctx.softDeletable.has(table)) {
      opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
    }
    const n = await ctx.db.boundedCount(table, opts);
    // At the cap the engine stopped counting, so `n` is a floor. Carried, not
    // rounded away — a floor presented as a total understates the blast radius on
    // the one screen where the user decides whether to allow it.
    return { n, unknown: false, saturated: n > DESTRUCTIVE_COUNT_CAP };
  } catch (e) {
    // Loud, never silent: an uncountable target is treated as WIDE (needs
    // confirmation), never as "0 records, go ahead".
    console.warn(`[assistant] could not pre-count "${table}": ${(e as Error).message}`);
    return { n: 0, unknown: true, saturated: false };
  }
}

/** Two counts added up, keeping "unknown" and "floor" sticky across the sum. */
function addCounts(a: RowCount, b: RowCount): RowCount {
  return {
    n: a.n + b.n,
    unknown: a.unknown || b.unknown,
    saturated: a.saturated || b.saturated,
  };
}

/**
 * The records a `delete_cascade` destroys OUTSIDE the object it names — bounded,
 * SQL-side, one query per inbound relation.
 *
 * `delete_entity` with `resolution='delete_cascade'` removes the named object's own
 * rows AND the rows of every other object that points at it (`removeInboundLinks`).
 * The gate counted only the first half, so the collateral escaped BOTH the size
 * threshold and the durable refusal: removing a 3-record object that 4,000 records
 * point at counted as 3 and ran unasked, and the card told the user "3 record(s)".
 *
 * Counted from the SAME declared-relation model the executor walks (the workspace
 * config's `belongsTo` relations), and deliberately counts EVERY inbound relation —
 * including the pure link tables `removeInboundLinks` sweeps away by soft-deleting
 * the whole table rather than row by row. Those rows stop existing for the user just
 * the same, and counting them means an ownership misclassification can only ever make
 * this number too BIG. Over-stating asks the user one extra time; under-stating is the
 * defect being fixed.
 *
 * Fails CLOSED in every direction: no relation model wired into this process, a config
 * that will not parse, or a count that will not run all return `unknown`, which the
 * gate reads as WIDE and the card prints as "record count unknown". Never 0.
 */
async function countCascade(ctx: DispatchCtx, target: string): Promise<RowCount> {
  const { configPath, outputDir } = ctx;
  if (!configPath || !outputDir) {
    // Nothing to read the relation model out of, so the cascade cannot be enumerated
    // at all. In the server this is unreachable (the chat route always wires both from
    // the active workspace); reaching it means we genuinely do not know.
    return { n: 0, unknown: true, saturated: false };
  }
  const inbound: { table: string; foreignKey: string }[] = [];
  try {
    // `includeEntities: false` — this needs the declared tables only, never the
    // O(files) rendered-tree scan.
    for (const t of loadGuiData(configPath, outputDir, false).tables) {
      if (t.name === target) continue;
      for (const rel of Object.values(t.relations)) {
        if (rel.type === 'belongsTo' && rel.table === target) {
          inbound.push({ table: t.name, foreignKey: rel.foreignKey });
        }
      }
    }
  } catch (e) {
    console.warn(
      `[assistant] could not read what links to "${target}": ${(e as Error).message} — treating the cascade as uncountable`,
    );
    return { n: 0, unknown: true, saturated: false };
  }
  let total = 0;
  for (const link of inbound) {
    const filters: { col: string; op: 'isNotNull' | 'isNull' }[] = [
      { col: link.foreignKey, op: 'isNotNull' },
    ];
    if (ctx.softDeletable.has(link.table)) filters.push({ col: 'deleted_at', op: 'isNull' });
    try {
      const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
        cap: DESTRUCTIVE_COUNT_CAP,
      };
      opts.filters = filters as NonNullable<typeof opts.filters>;
      total += await ctx.db.boundedCount(link.table, opts);
    } catch (e) {
      console.warn(
        `[assistant] could not count what "${link.table}" links to "${target}": ${(e as Error).message}`,
      );
      return { n: total, unknown: true, saturated: false };
    }
    // Past the cap the exact figure cannot change anything the gate decides, and
    // continuing would only add more unbounded work. Stop, and say it is a floor.
    if (total > DESTRUCTIVE_COUNT_CAP) {
      return { n: total, unknown: false, saturated: true };
    }
  }
  return { n: total, unknown: false, saturated: false };
}

/**
 * How many junction rows an `unlink` will really delete — bounded, SQL-side.
 *
 * `db.unlink` is a SET delete: `DELETE FROM t WHERE <every key of values>`. The gate
 * hardcoded `rows: 1`, so one call could destroy every link a record has (or, with a
 * single condition, every link in the object) while the gate believed it was one row
 * and the card said "remove 1 link". The conditions are the same ones the DELETE will
 * use, so this counts exactly what the call destroys.
 *
 * No `deleted_at IS NULL` clause: the DELETE is a HARD one and takes trashed junction
 * rows with it, so filtering them out would under-count.
 */
async function countUnlink(
  ctx: DispatchCtx,
  table: string,
  conditions: { col: string; val: unknown }[],
): Promise<RowCount> {
  try {
    const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
      cap: DESTRUCTIVE_COUNT_CAP,
    };
    opts.filters = conditions.map((c) => ({ col: c.col, op: 'eq' as const, val: c.val }));
    const n = await ctx.db.boundedCount(table, opts);
    return { n, unknown: false, saturated: n > DESTRUCTIVE_COUNT_CAP };
  } catch (e) {
    console.warn(
      `[assistant] could not pre-count an unlink on "${table}": ${(e as Error).message}`,
    );
    return { n: 0, unknown: true, saturated: false };
  }
}

/**
 * Classify a call as destructive and measure its blast radius BEFORE it runs.
 * Returns null for anything that destroys nothing — including a `delete_entity`
 * with no resolution on a non-empty object (that call only reports what is in the
 * way) and a `move_to` merge (reversible by design, and the model is told so).
 *
 * Exported so the size of an act is measured in ONE place, from the call's real
 * arguments — never from the model's description of its own plan. Two derivations of
 * "what this call destroys" would be two chances to disagree, and the disagreement
 * would land in favour of whichever one the user was shown.
 *
 * The exported form exists to guarantee ONE property the branches below must never be
 * trusted to remember individually: every `detail` it returns has been through
 * {@link safeDetail}. `detail` is the sentence the user reads about a refused act, so
 * a branch that interpolates something model-supplied without flattening it is a
 * branch that writes attacker-chosen prose into it. Enforced here, once.
 */
export async function destructiveIntent(
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<DestructiveIntent | null> {
  const intent = await classifyDestructive(ctx, name, args);
  return intent ? { ...intent, detail: safeDetail(intent.detail) } : null;
}

async function classifyDestructive(
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<DestructiveIntent | null> {
  if (!REMOVAL_TOOLS.has(name)) return null;
  if (name === 'delete_entity') {
    const target = typeof args.name === 'string' ? args.name : '';
    if (!target) return null;
    if (typeof args.move_to === 'string' && args.move_to) return null; // reversible merge
    const rows = await countRows(ctx, target);
    const cascade = args.resolution === 'delete_cascade';
    const resolved = args.resolution === 'delete_data' || cascade;
    // No resolution + records present ⇒ the call reports what is in the way and
    // removes nothing, so there is nothing to gate yet.
    if (!resolved && rows.n > 0 && !rows.unknown) return null;
    // A cascade destroys in OTHER objects too, and the gate used to measure only this
    // one — so the collateral escaped the size threshold entirely. Counted here so
    // `rows` is the size of the ACT, not the size of the object.
    const collateral = cascade ? await countCascade(ctx, target) : null;
    const total = collateral ? addCounts(rows, collateral) : rows;
    // The RESOLUTION is the whole difference between "remove the object, keep the
    // records" and "remove it and everything in it, plus everything pointing at it",
    // and the refusal used to say neither — every one of them read "remove X (N
    // records)". The user is told which act was refused, so they know what they are
    // about to do themselves.
    const scale = countPhrase(rows);
    return {
      kind: 'remove_object',
      target,
      rows: total.n,
      ...(total.unknown ? { rowsUnknown: true } : {}),
      ...(total.saturated ? { rowsSaturated: true } : {}),
      detail:
        cascade && collateral
          ? `remove "${target}", DELETE its ${scale}, and delete ` +
            (collateral.unknown
              ? 'an unknown number of records'
              : `up to ${String(collateral.n)}${collateral.saturated ? '+' : ''} record(s)`) +
            ` in other objects that point at them`
          : resolved
            ? `remove "${target}" and DELETE its ${scale}`
            : `remove "${target}" (${scale}, none of them deleted)`,
    };
  }
  if (name === 'delete_row') {
    const target = typeof args.table === 'string' ? args.table : '';
    const id = typeof args.id === 'string' ? args.id : '';
    if (!target || !id) return null;
    // An id that names no record destroys nothing, and the handler's own error is the
    // honest answer. This is also the gate that keeps model PROSE out of the refusal
    // text: `args.id` is unvalidated model text, and a line was measured reading
    // "delete record n_1 (a test copy — the real data is untouched, safe) from
    // notes". A sentence is not a record.
    if ((await countExisting(ctx, target, [id])) === 0) return null;
    // Names WHICH record, so a refusal the user acts on themselves points at the
    // right one.
    return {
      kind: 'delete_records',
      target,
      rows: 1,
      detail:
        `delete ${idPhrase(id, '1 record')} from "${target}"` +
        `${args.hard === true ? ' permanently' : ''} — this one record, not any other`,
    };
  }
  if (name === 'update_row') {
    // The same destruction `bulk_update` is gated for, addressed one row at a time.
    // Setting real values is an ordinary edit; CLEARING them is not.
    const target = typeof args.table === 'string' ? args.table : '';
    const id = typeof args.id === 'string' ? args.id : '';
    if (!target || !id || !args.values || typeof args.values !== 'object') return null;
    if (Array.isArray(args.values)) return null;
    const cleared = clearedKeys(args.values as Record<string, unknown>);
    if (cleared.length === 0) return null;
    // Checked against the table's REAL columns, for the same reason bulk_update is:
    // the keys are arbitrary model strings and they end up on the card.
    const known = ctx.db.getRegisteredColumns(target);
    const named = known ? cleared.filter((c) => isColumn(known, c)) : cleared;
    if (named.length === 0) return null;
    if ((await countExisting(ctx, target, [id])) === 0) return null;
    return {
      kind: 'clear',
      target,
      rows: 1,
      detail:
        `clear ${named.map((c) => `"${cardValue(c, 'a field')}"`).join(', ')} ` +
        alsoOverwrites(writeMap(args.values), known) +
        `on ${idPhrase(id, '1 record')} in "${target}"`,
    };
  }
  if (name === 'unlink') {
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    // The junction row's KEYS are arbitrary model strings that land in a SQL
    // IDENTIFIER position (`DELETE FROM t WHERE "<key>" = ?`) — the third instance of
    // the class already closed for bulk_update's filter and its `set`. Validated here
    // against the table's real columns AND, at the executing edge, by the same parser
    // the handler runs. A call naming a column that does not exist deletes nothing (the
    // handler rejects it), so there is nothing to gate — the handler's own error is the
    // honest answer. A junction whose column set is UNKNOWABLE rejects every key for
    // the same reason: an unchecked key is one that reaches the identifier position
    // unchecked, and refusing is the only direction that cannot destroy anything. (Not
    // reachable today — the tool is restricted to `junctionTables`, and every member of
    // that set is registered, whether it came from the config or from
    // `materializeJunction`'s defineLate.)
    let conditions: { col: string; val: unknown }[];
    try {
      conditions = parseJunctionValues(args.values, target, ctx.db);
    } catch {
      return null;
    }
    // `db.unlink` returns without deleting when there are no conditions.
    if (conditions.length === 0) return null;
    // `db.unlink` is an UNBOUNDED set delete — `DELETE FROM t WHERE <every key>` — so
    // one call can cut every link a record has. This used to be hardcoded to 1.
    const rows = await countUnlink(ctx, target, conditions);
    // Nothing matches ⇒ nothing is destroyed. Never reached when the count failed:
    // that comes back `unknown`, which is wide, not zero.
    if (rows.n === 0 && !rows.unknown) return null;
    return {
      kind: 'unlink',
      target,
      rows: rows.n,
      ...(rows.unknown ? { rowsUnknown: true } : {}),
      ...(rows.saturated ? { rowsSaturated: true } : {}),
      detail: rows.unknown
        ? `remove links from "${target}" — link count unknown`
        : `remove ${rows.saturated ? 'at least ' : ''}${String(rows.n)} link(s) from "${target}" — ` +
          `EVERY link matching this one, not just one`,
    };
  }
  if (name === 'merge_rows') {
    // The call NAMES the records it will collapse, so this is the one destructive
    // call whose identity is fully known before it runs — which is why the refusal
    // can name them back to the user.
    const target = typeof args.table === 'string' ? args.table : '';
    const raw = Array.isArray(args.duplicate_ids) ? args.duplicate_ids : null;
    // A malformed call destroys nothing (the handler rejects it) — that error is the
    // handler's to report verbatim, not the gate's to pre-empt with a refusal.
    if (!target || !raw || raw.length === 0) return null;
    const survivor = typeof args.survivor_id === 'string' ? args.survivor_id : '';
    // `mergeDuplicates` drops the survivor and blanks from the list, so the records
    // really at stake are the rest — and only the ones that exist.
    const ids = [
      ...new Set(
        raw.filter((v): v is string => typeof v === 'string' && v !== '' && v !== survivor),
      ),
    ];
    if (ids.length === 0) return null;
    const real = await countExisting(ctx, target, ids);
    if (real === 0) return null;
    // Name the records ONLY when every one of them is a record. Listing three ids
    // beside a count that excludes some of them would put two different numbers of
    // things on one line, and the card is the screen where a person decides.
    const shown = real === ids.length ? idListPhrase(ids, 3) : '';
    return {
      kind: 'delete_records',
      target,
      rows: real,
      detail:
        `merge ${String(real)} named record(s) into 1 in "${target}"` +
        (shown ? ` (${shown})` : '') +
        ` — only these, and the merged-away records are moved to the trash (recoverable)`,
    };
  }
  if (name === 'dedup') {
    // ── THIS NUMBER IS A BOUND, NOT A MEASUREMENT — AND IT HAS TO STAY ONE ──────
    //
    // The duplicate scan is NOT run here. The live row count bounds the loss instead:
    // a table with N live rows can lose at most N−1 to merging, because every group
    // keeps its survivor. That is deliberately conservative and it is deliberately
    // cheap — one `COUNT(*)`, SQL-side, no rows read.
    //
    // Measuring it honestly would mean running `findTableDuplicates` pre-flight. That
    // was built and then reverted, because the scan is QUADRATIC and SYNCHRONOUS, so
    // running it inside the gate stops the entire server:
    //
    //   • `groupNear` (src/dedup/index.ts) blocks candidates by the first 4 characters
    //     of the key, then compares EVERY PAIR inside a block with `bigramDice`. There
    //     is no `await` anywhere in that double loop, so the block is O(k²) of
    //     uninterrupted CPU.
    //   • `fileContentGroups` (src/gui/dedup-service.ts) builds a fuzzy `files` key as
    //     `'txt:' + normalizeText(extracted_text).slice(0, 2000)`. Every file row
    //     therefore shares the 4-character prefix `txt:` — the blocking degenerates,
    //     the whole table lands in ONE block, and each of the k²/2 comparisons is over
    //     strings up to 2000 characters long.
    //
    // Measured: a fuzzy `dedup` on a 1,200-row `files` table blocked the Node event
    // loop for 104 SECONDS. A 50ms heartbeat fired zero times across it. For that whole
    // stretch every HTTP request, every WebSocket and SSE stream, every other user's
    // session, and the Stop button are dead — and the call is then REFUSED anyway,
    // because 1,200 duplicates is far over the threshold. The bound refuses that exact
    // call instantly off a bounded `COUNT(*)`, which is what keeps the quadratic path
    // unreachable from the gate at any table size.
    //
    // WHAT THE BOUND COSTS, stated plainly so nobody rediscovers it as a surprise: a
    // table over DESTRUCTIVE_ROW_THRESHOLD is refused even when only a handful of its
    // records are really duplicates, and the model cannot narrow the call — `dedup`
    // takes a table name and a `fuzzy` flag and nothing else. That is a real product
    // limitation and it is the accepted trade: freezing the server for two minutes is
    // far worse than refusing a de-duplication the person can run from the app.
    //
    // FIXING THE SCAN IS THE PREREQUISITE for measuring this honestly. Not the gate —
    // the scan. It needs a blocking key that actually partitions (`files` must not key
    // every row on a constant `txt:` prefix), a per-block size cap so one pathological
    // block cannot go quadratic, and a yield to the event loop between blocks. Until
    // all three exist, do NOT re-introduce a pre-flight scan here, and do not "just
    // guard it" with an allowlist or a row cap — the cost is in the scan, and any
    // reachable path to it is a path to a frozen server.
    //
    // One more property the bound has to carry: it is only a true UPPER bound while the
    // count is a true total. Past DESTRUCTIVE_COUNT_CAP it is not — `boundedCount` stops
    // there, so a 12,000-row table reports 5001 and "up to 5000" is SMALLER than the real
    // answer, not larger. Saturation is carried rather than asserted away, and the
    // phrasing becomes a floor.
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    const rows = await countRows(ctx, target);
    const most = rows.n > 0 ? rows.n - 1 : 0;
    // WHICH scan is the whole act, and the refusal used to say neither: an exact pass
    // merges only records that are already identical (often none), while a fuzzy pass
    // merges whatever a similarity score calls close enough. The bound cannot tell them
    // apart — that is exactly what makes it a bound — but the sentence still has to say
    // which one was refused, because it is what the person goes and does themselves.
    const fuzzy = args.fuzzy === true;
    return {
      kind: 'delete_records',
      target,
      rows: most,
      ...(rows.unknown ? { rowsUnknown: true } : {}),
      ...(rows.saturated ? { rowsSaturated: true } : {}),
      detail:
        `merge ${fuzzy ? 'SIMILAR (fuzzy-matched)' : 'exactly identical'} duplicate records in ` +
        `"${target}" — a BOUND, not a count (the duplicate scan is not run here): ` +
        (rows.unknown
          ? 'record count unknown'
          : rows.saturated
            ? `at least ${String(most)} record(s), possibly far more`
            : `up to ${String(most)} record(s)`) +
        ` could be merged away, and those go to the trash (recoverable)`,
    };
  }
  // bulk_update is destructive only when it CLEARS values — the "unlink 40 rows
  // to make a delete possible" move. Setting real values is an ordinary edit.
  const target = typeof args.table === 'string' ? args.table : '';
  if (!target || !args.set || typeof args.set !== 'object') return null;
  const set = args.set as Record<string, unknown>;
  const cleared = clearedKeys(set);
  if (cleared.length === 0) return null;
  // The set KEYS are arbitrary model-supplied strings and they end up on the card, so
  // they are checked against the table's real columns first. A name that is not a
  // column of this table is not describing a destruction — it is describing a call
  // that will fail — and it has no business being read as part of the confirmation.
  // When the column set is unknowable (an unregistered relation) the names are kept
  // rather than dropped: dropping them would UNDER-state the call, and understating a
  // destruction is the failure direction. Either way they are bounded by cardValue.
  const known = ctx.db.getRegisteredColumns(target);
  const named = known ? cleared.filter((c) => isColumn(known, c)) : cleared;
  // PARSE and COUNT are two different failures and must not share one handler.
  // Parsing fails when the filter is malformed or names a column that does not
  // exist — the handler raises the identical error, so pre-empting it with a
  // confirmation demand would be noise. Counting fails when the DATABASE could not
  // answer, and that is the fail-CLOSED case: it used to land in the same `catch`
  // and return null, so a clear whose blast radius could not be measured was treated
  // as destroying nothing and ran ungated. `countRows` has always treated an
  // uncountable target as wide; this branch is now consistent with it.
  let parsed: { col: string; op: string; val?: unknown }[];
  try {
    parsed = parseBulkFilters(args.filter, target, ctx.db);
  } catch {
    return null;
  }
  let rows: RowCount;
  try {
    const filters = [...parsed];
    if (ctx.softDeletable.has(target)) filters.push({ col: 'deleted_at', op: 'isNull' });
    const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
      cap: DESTRUCTIVE_COUNT_CAP,
    };
    opts.filters = filters as NonNullable<typeof opts.filters>;
    const n = await ctx.db.boundedCount(target, opts);
    rows = { n, unknown: false, saturated: n > DESTRUCTIVE_COUNT_CAP };
  } catch (e) {
    console.warn(`[assistant] could not pre-count a clear on "${target}": ${(e as Error).message}`);
    rows = { n: 0, unknown: true, saturated: false };
  }
  // Every real column of the call was filtered out ⇒ it clears nothing that exists,
  // so it destroys nothing and the handler's own error is the honest answer.
  if (named.length === 0) return null;
  // "Every record in the object" and "whichever records this filter selects" are
  // different acts, and the sentence has to say which. No filter at all is its own
  // case, not an empty one.
  const scoped = parsed.length > 0;
  return {
    kind: 'clear',
    target,
    rows: rows.n,
    // Carried, so an uncountable clear reads as WIDE at the gate and as "record count
    // unknown" in the refusal — never as a clear of zero records.
    ...(rows.unknown ? { rowsUnknown: true } : {}),
    ...(rows.saturated ? { rowsSaturated: true } : {}),
    // Says WHAT is at stake without claiming more precision than was measured: the
    // count is a bound on the filter's selection, not a list of specific records.
    detail:
      `clear ${named.map((c) => `"${cardValue(c, 'a field')}"`).join(', ')} ` +
      alsoOverwrites(set, known) +
      `on ${countPhrase(rows)} in "${target}" — ` +
      (scoped
        ? `whichever records this call's filter selects, up to that many`
        : `EVERY record in it`),
  };
}

/** True for the `delete_entity` result that means "nothing was removed, ask first". */
function isNeedsResolution(result: unknown): result is { rowCount?: number } {
  return !!result && typeof result === 'object' && 'needsResolution' in result;
}

/** How many records a completed destructive call actually touched. */
function affectedRows(attempt: ToolAttempt): number {
  const r = attempt.result;
  if (r && typeof r === 'object' && typeof (r as { affected?: unknown }).affected === 'number') {
    return (r as { affected: number }).affected;
  }
  return attempt.destructive?.rows ?? 0;
}

function firstLine(error: string | undefined): string {
  const s = (error ?? 'no reason given').trim().replace(/\s+/g, ' ');
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

/**
 * AXIS 1 — destruction. Two claims to police: "I removed those" when the removal
 * failed, and the silence around the unlinks/clears that were done to ENABLE a
 * removal that then failed, leaving the workspace strictly worse than before.
 */
const destructiveVerifier: ClaimVerifier = {
  axis: 'destructive',
  facts(attempts, turn) {
    const out: OutcomeFact[] = [];
    for (const a of attempts) {
      if (!a.ok && a.destructive) {
        // A merge destroys by CONSOLIDATING, not by removing the object — reporting
        // "X was not removed" for a refused merge would describe an act nobody asked
        // for. Same fact, stated in the terms of the call that was actually made.
        const merging = a.name === 'merge_rows' || a.name === 'dedup';
        out.push({
          axis: 'destructive',
          kind: 'not_done',
          key: `destructive:not_done:${a.name}:${a.destructive.target}`,
          statement: merging
            ? a.refused
              ? `NOTHING in "${a.destructive.target}" was merged — a change that size is not one you can carry out.`
              : `NOTHING in "${a.destructive.target}" was merged. The call failed: ${firstLine(a.error)}`
            : a.refused
              ? `"${a.destructive.target}" was NOT removed — a change that size is not one you can carry out.`
              : `"${a.destructive.target}" was NOT removed. The call failed: ${firstLine(a.error)}`,
          userStatement: merging
            ? a.refused
              ? `Nothing in ${friendly(a.destructive.target)} has been combined — a change that size is one to make yourself, in the app.`
              : `Nothing in ${friendly(a.destructive.target)} could be combined, so it is unchanged.`
            : a.refused
              ? `${friendly(a.destructive.target)} has not been removed — a change that size is one to make yourself, in the app.`
              : `${friendly(a.destructive.target)} could not be removed, so it is still there.`,
          // NOT provisional. It used to be: a gate refusal ended the turn on a
          // confirmation card that said the same thing, so repeating it in the notice
          // was noise. There is no card now, and the refusal explicitly tells the model
          // not to ask anything — so if this were suppressed whenever the turn happened
          // to end on some unrelated ask_user, the user would be told nothing at all
          // about a removal that did not happen.
        });
      } else if (a.ok && a.name === 'delete_entity' && isNeedsResolution(a.result)) {
        const target = typeof a.args.name === 'string' ? a.args.name : 'that object';
        const held = a.result.rowCount;
        out.push({
          axis: 'destructive',
          kind: 'not_done',
          key: `destructive:not_done:pending:${target}`,
          statement:
            `"${target}" was NOT removed — it still holds ` +
            `${typeof held === 'number' ? String(held) : 'some'} record(s) and no decision was given ` +
            `about them.`,
          userStatement: `${friendly(target)} has not been removed — it still has records in it.`,
          provisional: true,
        });
      }
    }
    // Residue: destructive work that DID land and is still applied. Two ways a turn
    // gets here — a removal it was preparing for then failed, or the user stopped
    // the turn part-way. The stop case is the one most likely to go untold, and the
    // one where it matters most: they stopped BECAUSE something looked wrong, and
    // the turn never reaches an answer that could have explained itself.
    const halfApplied = out.length > 0;
    if (!halfApplied && !turn.stopped) return out;
    const done = attempts.filter(
      (a) =>
        a.ok &&
        a.destructive &&
        // Interrupted: everything already destroyed counts, not only the
        // unlink/clear groundwork of a removal that was still to come.
        (turn.stopped || a.destructive.kind === 'unlink' || a.destructive.kind === 'clear'),
    );
    if (done.length > 0) {
      const rows = done.reduce((n, a) => n + affectedRows(a), 0);
      const objects = [...new Set(done.map((a) => a.destructive?.target ?? ''))].filter(Boolean);
      const names = objects.map(friendly).join(', ');
      out.push({
        axis: 'destructive',
        kind: 'residue',
        key: 'destructive:residue',
        statement: turn.stopped
          ? `The turn was STOPPED part-way. ${String(rows)} record(s) across ` +
            `${String(objects.length)} object(s) (${objects.join(', ')}) had ALREADY been changed ` +
            `by then, and those changes are still applied.`
          : `${String(rows)} record(s) across ${String(objects.length)} object(s) (${objects.join(', ')}) ` +
            `WERE unlinked/cleared to make that removal possible, and those changes are still applied. ` +
            `The workspace is now half-changed: links gone, objects still present.`,
        userStatement: turn.stopped
          ? `${String(rows)} record(s) in ${names} had already been changed when you stopped, and ` +
            `those changes are still in place.`
          : `${String(rows)} record(s) in ${names} were already unlinked to prepare for that, and those ` +
            `changes are still in place — so those records are now disconnected.`,
        undo: 'Offer to undo them; every change this turn can be reversed from version history.',
      });
    }
    return out;
  },
};

/**
 * AXIS 2 — authored documents. "The file is now in your workspace" when nothing
 * was stored, or when the delegated author returned a stub.
 */
const artifactVerifier: ClaimVerifier = {
  axis: 'artifact',
  facts(attempts) {
    const out: OutcomeFact[] = [];
    for (const a of attempts) {
      if (a.name !== 'create_artifact') continue;
      const title = typeof a.args.title === 'string' ? a.args.title : 'that document';
      if (!a.ok) {
        out.push({
          axis: 'artifact',
          kind: 'not_done',
          key: `artifact:not_done:${title}`,
          statement: `The document "${title}" was NOT saved: ${firstLine(a.error)}`,
          userStatement: `"${title}" was not saved, so it is not in your files.`,
        });
        continue;
      }
      const chars = (a.result as { chars?: unknown } | undefined)?.chars;
      const authored = typeof a.args.spec === 'string' && a.args.spec.trim().length > 0;
      if (authored && typeof chars === 'number' && chars < MIN_AUTHORED_ARTIFACT_CHARS) {
        out.push({
          axis: 'artifact',
          kind: 'suspect',
          key: `artifact:suspect:${title}`,
          statement:
            `The document "${title}" was saved but is only ${String(chars)} characters — far shorter ` +
            `than the request implies. Do NOT describe it as a complete document.`,
          userStatement: `"${title}" saved, but it came out very short — it may not be what you asked for.`,
        });
      }
    }
    return out;
  },
};

/**
 * AXIS 3 — dashboards. A page whose queries return nothing is not "healthy"; it
 * is a page of zeros, and the answer must say so.
 */
const dashboardVerifier: ClaimVerifier = {
  axis: 'dashboard',
  facts(attempts) {
    const out: OutcomeFact[] = [];
    for (const a of attempts) {
      if (a.name !== 'create_dashboard' && a.name !== 'edit_dashboard') continue;
      const title = typeof a.args.title === 'string' ? a.args.title : 'that dashboard';
      if (!a.ok) {
        out.push({
          axis: 'dashboard',
          kind: 'not_done',
          key: `dashboard:not_done:${a.name}:${title}`,
          statement: `The dashboard "${title}" was NOT ${a.name === 'edit_dashboard' ? 'updated' : 'created'}: ${firstLine(a.error)}`,
          userStatement: `"${title}" is not ready — the data behind it did not load.`,
        });
        continue;
      }
      const issues = (a.result as { qaIssues?: { kind?: string }[] } | undefined)?.qaIssues ?? [];
      const empty = issues.filter((i) => i.kind === 'no_data' || i.kind === 'sql_error').length;
      if (empty > 0) {
        out.push({
          axis: 'dashboard',
          kind: 'suspect',
          key: `dashboard:suspect:${title}`,
          statement:
            `The dashboard "${title}" was saved, but ${String(empty)} of its figures returned NO data. ` +
            `It will read as zeros/blanks — do NOT report it as healthy or complete.`,
          userStatement: `"${title}" is up, but ${String(empty)} of its figures have no data behind them yet — they will show as zero.`,
        });
      }
    }
    return out;
  },
};

/**
 * The registered axes. A fourth axis is one more entry here plus its `facts()` —
 * the ledger, the injection point, and the user notice are already shared.
 */
export const CLAIM_VERIFIERS: readonly ClaimVerifier[] = [
  destructiveVerifier,
  artifactVerifier,
  dashboardVerifier,
];

/**
 * The per-turn record of what the tools actually did, the pre-flight gate on wide
 * and multi-object destruction, and the reconciliation the final answer is measured
 * against.
 *
 * One instance per assistant turn. The chat loop hands it to every
 * {@link executeFunction} call, injects {@link reconciliation} into the model's
 * context before the answer round, and emits {@link userNotice} on the stream so
 * the truth reaches the user even if the answer never mentions it. A turn the user
 * STOPS never reaches an answer at all — {@link markStopped} is what makes the
 * notice cover it, since that is the turn most likely to leave changes behind.
 *
 * The ledger holds NO authorization state, because there is none to hold. A wide or
 * multi-object removal is not something the assistant can be authorized to do; see
 * {@link gateDestructive}.
 */
export class TurnOutcomeLedger {
  private readonly attempts: ToolAttempt[] = [];
  /** Pre-flight classifications, keyed by the (unique) args object of the call. */
  private readonly intents = new WeakMap<object, DestructiveIntent>();
  /** Destructive targets already acted on this turn → records at stake, for the
   *  refusal text. Its size is the plan's size so far. */
  private readonly touched = new Map<string, number>();
  /**
   * Records this turn's destructive calls have put at stake, accumulated across the
   * WHOLE turn — every call that ran, whether or not it landed. Counting only what
   * succeeded measured the damage done rather than the plan attempted, so a plan
   * split into single-target calls (or one re-attempted after it failed) could keep
   * slipping under the threshold round after round and never be refused.
   */
  private plannedRows = 0;
  /** Set when the user stops the turn, so the notice can report the interruption. */
  private stopped = false;

  /** The user stopped this turn: whatever already landed is now the whole story. */
  markStopped(): void {
    this.stopped = true;
  }

  get counts(): { attempted: number; succeeded: number; failed: number } {
    const attempted = this.attempts.length;
    const succeeded = this.attempts.filter((a) => a.ok).length;
    return { attempted, succeeded, failed: attempted - succeeded };
  }

  /** Every executed/refused call this turn, oldest first. */
  get calls(): readonly ToolAttempt[] {
    return this.attempts;
  }

  /**
   * PRE-FLIGHT GATE. Returns an instructive refusal when this call is part of a
   * destructive plan that spans more than one object, or that has grown wider than
   * {@link DESTRUCTIVE_ROW_THRESHOLD} records ACROSS the turn — otherwise null.
   * Enforced as a rejected tool call, not as a prompt rule, because a prompt rule is
   * exactly what failed here.
   *
   * The refusal is UNCONDITIONAL. There is no approval, no confirmation, no record the
   * assistant can obtain that makes a wide or multi-object removal runnable, because
   * the capability is not offered at all.
   *
   * That is a deliberate retreat from an assistant-side consent system, which was
   * built and then removed: seven adversarial review rounds each found a way to forge,
   * widen, replay or outlive an approval, and most rounds' fixes opened roughly two
   * new holes while closing four. Every one of those holes came from the same place —
   * authority derived inside a conversation the model can steer. A person can still do
   * every one of these operations, in the GUI, where the confirmation is a real action
   * on a real screen and no authorization record has to exist or be defended. Removing
   * the capability collapses forged approval, identity binding, decline durability and
   * spend semantics into a question nobody has to answer.
   *
   * Small, single-object removals under the threshold are untouched: they are what the
   * assistant is for, they are already recorded in version history, and they are the
   * boundary this gate has always drawn.
   */
  async gateDestructive(
    ctx: DispatchCtx,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const intent = await destructiveIntent(ctx, name, args);
    if (!intent) return null;
    this.intents.set(args, intent);

    const targets = new Map(this.touched);
    targets.set(intent.target, Math.max(targets.get(intent.target) ?? 0, intent.rows));
    const totalRows = this.plannedRows + intent.rows;
    const multiTarget = targets.size > 1;
    const unknownRows = intent.rowsUnknown === true;
    // An uncountable act is WIDE, never harmless: "we could not measure it" is not
    // "it is small".
    const wide = totalRows > DESTRUCTIVE_ROW_THRESHOLD || unknownRows;
    if (!multiTarget && !wide) return null;

    // Name the objects and their record counts. This is the whole point of the
    // refusal text: the user is being told to go and do this themselves, so they have
    // to be told WHAT and HOW MUCH. A refusal that only says no sends them back to ask
    // the assistant the same question in different words.
    const describe = (t: string, n: number): string =>
      t === intent.target && unknownRows
        ? `"${t}" (record count unknown)`
        : `"${t}" (${String(n)} record(s))`;
    const objects = [...targets].map(([t, n]) => describe(t, n));
    const friendlyObjects = [...targets.keys()].map(friendly).join(', ');
    const already = [...this.touched].map(([t, n]) => `"${t}" (${String(n)} record(s))`);
    const reason = multiTarget
      ? `it removes from more than one object: ${objects.join(', ')}`
      : `it reaches ${unknownRows ? 'an unknown number of' : `${String(totalRows)} `}record(s) in ` +
        `"${intent.target}" — past the ${String(DESTRUCTIVE_ROW_THRESHOLD)} a single small change ` +
        `stays under`;
    return (
      `REFUSED — nothing was changed by this call, and nothing you do in this conversation will ` +
      `change that. An operation this size is not something you can carry out: ${reason}.\n` +
      `About to: ${intent.detail}.\n` +
      (already.length > 0 ? `Already acted on this turn: ${already.join(', ')}.\n` : '') +
      `A change like this is made by the person themselves, in the app, where they can see what ` +
      `they are changing before it happens. Tell them plainly that you cannot do this one for ` +
      `them, name exactly what has to change — ${friendlyObjects} — with the record counts above, ` +
      `and leave it with them.\n` +
      `Do NOT retry this call. Do NOT split it into smaller calls to get under the limit — the ` +
      `whole turn is counted. Do NOT ask them to confirm or approve it: there is no answer they ` +
      `can give that would let you do it, and asking only wastes their time. Never describe any ` +
      `of it as done.`
    );
  }

  /** Record a call the gate refused (nothing ran). */
  recordRefusal(name: string, args: Record<string, unknown>, error: string): void {
    const intent = this.intents.get(args);
    this.attempts.push({
      name,
      args,
      ok: false,
      error,
      refused: true,
      ...(intent ? { destructive: intent } : {}),
    });
  }

  /** Record a call that actually ran, with what it returned. */
  record(name: string, args: Record<string, unknown>, res: DispatchResult): void {
    const intent = this.intents.get(args);
    const attempt: ToolAttempt = {
      name,
      args,
      ok: res.ok,
      ...(res.result !== undefined ? { result: res.result } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(intent ? { destructive: intent } : {}),
    };
    this.attempts.push(attempt);
    if (intent) {
      // The target AND its records count toward the plan's size whether or not the
      // call landed — an attempted removal is still part of the plan the user must
      // agree to, and a failed one is usually about to be retried.
      this.touched.set(intent.target, Math.max(this.touched.get(intent.target) ?? 0, intent.rows));
      this.plannedRows += Math.max(intent.rows, res.ok ? affectedRows(attempt) : 0);
    }
  }

  /** Every fact the registered axes can prove about this turn, deduped by key. */
  facts(): OutcomeFact[] {
    const byKey = new Map<string, OutcomeFact>();
    const turn: TurnContext = { stopped: this.stopped };
    for (const v of CLAIM_VERIFIERS) {
      for (const f of v.facts(this.attempts, turn)) byKey.set(f.key, f);
    }
    return [...byKey.values()];
  }

  /**
   * The synthetic record injected into the model's context BEFORE it is allowed
   * to summarize the turn. Null when there is nothing to reconcile — a clean turn
   * pays nothing.
   *
   * This is also where the two rules that could cancel each other are reconciled
   * explicitly: routine PROCESS narration stays suppressed, OUTCOME truth is never
   * suppressed. A silent assistant that also destroyed data is worse than a chatty one.
   */
  reconciliation(): string | null {
    const facts = this.facts();
    const failures = this.attempts.filter((a) => !a.ok);
    if (facts.length === 0 && failures.length === 0) return null;
    const { attempted, succeeded, failed } = this.counts;
    const lines: string[] = [
      'TURN OUTCOME RECORD — generated from what your tool calls actually did, not from your summary.',
      `Calls this turn: ${String(attempted)} attempted, ${String(succeeded)} succeeded, ${String(failed)} failed.`,
    ];
    const notDone = facts.filter((f) => f.kind === 'not_done');
    if (notDone.length > 0) {
      lines.push('DID NOT HAPPEN — you must not state or imply otherwise:');
      for (const f of notDone) lines.push(`- ${f.statement}`);
    }
    const suspect = facts.filter((f) => f.kind === 'suspect');
    if (suspect.length > 0) {
      lines.push('HAPPENED BUT IS NOT A SUCCESS:');
      for (const f of suspect) lines.push(`- ${f.statement}`);
    }
    const residue = facts.filter((f) => f.kind === 'residue');
    if (residue.length > 0) {
      lines.push('ALREADY CHANGED AND STILL APPLIED — say this plainly and offer to undo it:');
      for (const f of residue) lines.push(`- ${f.statement}${f.undo ? ` ${f.undo}` : ''}`);
    }
    const other = failures.filter((a) => !a.destructive);
    if (other.length > 0) {
      lines.push('Other failed calls:');
      for (const a of other) lines.push(`- ${a.name}: ${firstLine(a.error)}`);
    }
    lines.push(
      'HOW TO REPORT THIS: keep suppressing routine process narration — the user does not need to ' +
        'hear how records are organised or linked. That suppression NEVER applies to the lines above. ' +
        'State every one of them in your final reply, in the user’s own business terms, plainly, ' +
        'and offer to undo anything still applied. Never call this turn done, clean, simplified, ' +
        'complete, or successful.',
    );
    return lines.join('\n');
  }

  /**
   * The deterministic user-facing notice — the truth the user gets whether or not
   * the model repeats it. Null when there is nothing to say.
   */
  userNotice(opts: { askedUser?: boolean } = {}): string | null {
    const facts = this.facts().filter((f) => !(opts.askedUser === true && f.provisional === true));
    if (facts.length === 0) return null;
    const parts = facts.map((f) => f.userStatement);
    const undoable = facts.some((f) => f.undo);
    return (
      parts.join(' ') +
      (undoable ? ' You can undo these changes — say "undo" and I will put them back.' : '')
    );
  }
}

/**
 * Executes a registry function on behalf of the AI tool loop. Writes flow
 * through the shared mutation primitives with `source='ai'`, so each AI action
 * lands in the audit log + activity feed exactly like a UI action — and is
 * undoable. Reads query the active Lattice directly.
 *
 * Scope: the data-centric functions an assistant needs to answer questions
 * about and edit the database. Schema, history, and database-management
 * functions are declared in the registry but not yet dispatchable; the chat
 * loop exposes only {@link DISPATCHABLE} to the model so it never calls a tool
 * that would just error.
 */

/**
 * Run a single tool call. Never throws — validation/runtime failures are
 * returned as `{ ok: false, error }` so the chat loop can hand the model a
 * tool_result it can recover from.
 *
 * When a {@link TurnOutcomeLedger} is supplied (the chat loop always supplies
 * one), the call additionally passes the destructive pre-flight gate and its
 * real outcome is recorded — so the turn's final answer can be reconciled
 * against what happened instead of against what the model believes happened.
 */
export async function executeFunction(
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
  ledger?: TurnOutcomeLedger,
): Promise<DispatchResult> {
  if (ledger) {
    // A fault in the SAFETY gate must not become a thrown error the loop treats
    // as a crash, and must not quietly wave the call through either: it comes
    // back as a loud, recoverable refusal naming the real fault.
    let refusal: string | null;
    try {
      refusal = await ledger.gateDestructive(ctx, name, args);
    } catch (e) {
      refusal = `Could not check whether this change needs the user's confirmation: ${(e as Error).message}. Nothing was changed. Ask the user before retrying.`;
      console.warn(`[assistant] destructive gate failed for ${name}: ${(e as Error).message}`);
    }
    if (refusal !== null) {
      ledger.recordRefusal(name, args, refusal);
      return { ok: false, error: refusal };
    }
  }
  const res = await runFunction(ctx, name, args);
  ledger?.record(name, args, res);
  return res;
}

/** The dispatch itself — unchanged behaviour, wrapped by {@link executeFunction}. */
async function runFunction(
  ctx: DispatchCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  if (!getFunction(name)) return { ok: false, error: `Unknown function: ${name}` };
  if (!DISPATCHABLE.has(name)) {
    return { ok: false, error: `Function "${name}" is not available to the assistant yet` };
  }
  // ask_user never reaches the dispatcher: the chat loop intercepts it (emits a
  // `question` stream event and ends the turn). A direct call has no user to ask.
  if (name === 'ask_user') {
    return { ok: false, error: 'ask_user is delivered through the chat stream, not dispatched' };
  }

  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'ai',
    // Stamp the GUI session that initiated this chat turn, so the assistant's
    // writes land in the SAME session-scoped undo/redo stack as a manual edit —
    // the user can undo what they asked the assistant to do.
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.onColumnsAdded ? { onColumnsAdded: ctx.onColumnsAdded } : {}),
  };

  try {
    // The dispatchable names partition disjointly across the five group
    // handlers; each returns NOT_HANDLED for a name it doesn't own. Try them in
    // source first-appearance order (read → row-mutations → collaboration →
    // computed → history) and return the first real result. The SAME ctx
    // reference is threaded to every group, so in-turn ctx.validTables /
    // ctx.junctionTables mutations stay visible to later cases. The single
    // try/catch below maps any group throw to { ok: false, error } exactly as
    // the prior switch did.
    const deps: HandlerDeps = { ctx, mctx, name, args };
    for (const group of [
      handleRead,
      handleRowMutations,
      handleCollaboration,
      handleComputed,
      handleHistory,
    ]) {
      const r = await group(deps);
      if (r !== NOT_HANDLED) return r;
    }
    return { ok: false, error: `Function "${name}" is not available to the assistant yet` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
