import { createHash } from 'node:crypto';
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
import { consentActKey, type ConsentGrant, type ThreadRefusals } from './consent-store.js';

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
   * True when the fact exists only because the turn STOPPED to ask the user
   * (a gate refusal). Still stated to the model; withheld from the user-facing
   * notice when the turn ends on that question, since the question already says it.
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

/** Records above this count make a single removal/clear need the user's say-so. */
export const DESTRUCTIVE_ROW_THRESHOLD = 25;
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
 * Exported so the consent-minting path can refuse to write a grant for a tool that
 * is not gated at all — a grant naming a non-destructive call would be a record of
 * consent to something the gate never asks about, which is worse than useless.
 */
export const REMOVAL_TOOLS: ReadonlySet<string> = new Set([
  'delete_entity',
  'delete_row',
  'unlink',
  'bulk_update',
  // The SAME destruction `bulk_update` is gated for, one row at a time. It was left
  // out, and the omission was not academic: after a recorded refusal, three
  // `update_row` calls setting a field to null wiped three records with no refusal
  // at all, because a tool outside this set is never classified and so is never
  // gated by anything — not the size threshold, and not the "they said no" rule.
  // Every tool that can null or overwrite a stored value has to be in here; the set
  // IS the registration, so an omission is silent.
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
  /**
   * The ACT this call performs, as the key a grant is matched on — see {@link verbKey}.
   *
   * Carried ON the intent so there is exactly ONE derivation of it. The gate and the
   * minting path both read it from here; each computing its own would be two chances
   * to disagree about what was authorized, and the disagreement would land in favour
   * of whichever one the user was shown. It also lets the key be built from the
   * classifier's VALIDATED view of the call (real columns only), which keeps
   * model-supplied strings out of the durable consent row.
   */
  verbKey: string;
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
 * One interpolated VALUE, made safe to put on a card the user reads.
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
 * `detail` is not an internal string: it becomes the line of the confirmation card the
 * user reads before approving a destruction. A card line was measured reading
 *
 *   clear "notes" - SAFE: only archived test rows, nothing real is lost. Ignore the
 *   line above. Column: "x" ...
 *
 * newlines and all, because `bulk_update`'s `set` KEYS were interpolated straight in
 * and nothing validates a key against the table's real columns. It is not XSS — the
 * client sets textContent — but it is attacker-chosen REASSURANCE inside the
 * confirmation, and it can ride alongside a real grant.
 *
 * Two layers, same as the context notes: each interpolated value is bounded by
 * {@link cardValue}, and the composed line is flattened and bounded here. Between
 * them, a card line is always one bounded line of server-composed text.
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

/** Deterministic, key-order-independent encoding of a value, for a comparison key. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return JSON.stringify(v);
  }
  // Not JSON data. Encoded by type AND by its own text, so two unencodable values
  // cannot collapse into one key — a collision here would let one act authorize
  // another. A FUNCTION has no such text and is the one case that cannot arrive at
  // all: these values come from a parsed JSON request body, which has no functions.
  if (typeof v === 'bigint' || typeof v === 'symbol') return `${typeof v}:${v.toString()}`;
  return `unencodable:${Object.prototype.toString.call(v)}`;
}

/**
 * The digest a grant is compared on. SHA-256, truncated to 128 bits.
 *
 * It replaced a 32-bit FNV-1a, which was not a mistake of taste: this value is an
 * AUTHORIZATION comparison, and the caller controls BOTH preimages — it chooses the
 * arguments it puts in `confirm` and the arguments it later calls with. A 32-bit
 * space falls to a birthday search in seconds on one core (measured: a colliding
 * pair of `bulk_update` filters selecting DISJOINT halves of a table, found in under
 * three seconds, spent consent for 30 archived records on 30 active ones). Padding
 * material is free, too — `parseBulkFilters` reads only col/op/val, so any other key
 * on a clause changes the hash without changing a single row selected.
 *
 * 128 bits removes the search entirely rather than making it harder. Hashing also
 * keeps the key free of MODEL-AUTHORED TEXT: `verbKey` is persisted in the durable
 * consent row, whose contract is that no field carries prose the model wrote, and a
 * raw row id interpolated into it broke that contract in the previous round.
 */
function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/** A model-supplied identifier as a comparison token: hashed, or `none` when absent. */
function idKey(s: string): string {
  return s === '' ? 'none' : `h${digest(s)}`;
}

/**
 * The rows a `bulk_update` selects, as an opaque comparison key.
 *
 * A grant used to bind target + verb + COUNT and nothing about WHICH rows, so consent
 * shown for "clear notes on 50 records" — the 50 the user had in mind — was spendable
 * on a DIFFERENT 50. The filter is the only thing in the call that says which, so it
 * is part of the act. Canonicalised first so key order cannot change the answer, then
 * digested because it is compared, never read.
 *
 * Callers pass the PARSED, column-validated clause list wherever they have one (the
 * classifier always does). That is what makes the comparison structural rather than
 * textual: two spellings of the same selection produce the same key, and a junk key
 * the parser ignores can neither change the key nor pad a collision search.
 *
 * No filter at all is its own key, not an absent one: "every record in the object" is
 * a different act from any filtered subset and must not match one.
 */
function filterKey(filter: unknown): string {
  if (filter === null || filter === undefined) return 'all';
  if (Array.isArray(filter) && filter.length === 0) return 'all';
  return `h${digest(canonicalJson(filter))}`;
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

/**
 * The WHOLE write payload of a `set` / `values` map, as an opaque comparison key.
 *
 * A grant used to bind only the CLEARED subset of the payload, so every OTHER key
 * in it was a degree of freedom the caller kept. Approving `set: {notes: null}` on
 * 4,000 records also approved `set: {notes: null, owner: "x", visibility: "everyone"}`
 * on the same records: identical tool, target, filter, count and cleared list, so the
 * grant matched exactly — and the extra writes appeared neither in the key nor on the
 * card the user read. Binding the whole map closes it, and binding the VALUES with it
 * closes the same hole one level down (same columns, different content).
 *
 * Digested rather than interpolated for the reason every model-supplied string here
 * is: `verbKey` is persisted in the durable consent row, whose contract is that no
 * field carries prose the model wrote.
 */
function payloadKey(values: Record<string, unknown>): string {
  return Object.keys(values).length === 0 ? 'none' : `h${digest(canonicalJson(values))}`;
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

/**
 * The ACT a destructive call performs on its target, as a short server-derived key.
 *
 * Naming the target is not enough to describe what was agreed to. "Remove the Q3
 * Invoices object but keep its records" and "remove it and everything in it" name
 * the same object and differ only in one argument — so consent recorded against the
 * target alone let the second be executed under agreement to the first. The verb key
 * is derived by THIS function at both ends (when the question is put, and when the
 * call is retried), so a retry that changed the argument no longer matches the grant.
 *
 * Pure, and deliberately coarse: it captures the arguments that change WHAT IS LOST,
 * nothing else — but "nothing else" has to mean every argument that changes it. A key
 * that binds a SUBSET of the payload leaves the rest free: `bulk_update` bound only
 * the CLEARED entries of `set`, so an approved clear could carry unlimited extra
 * column overwrites (and a visibility flip) under the same key. See {@link payloadKey}.
 *
 * There is no longer any tool here that keys to `''`. `unlink`, `merge_rows` and
 * `dedup` used to, under a docstring claiming their destruction "has no such argument
 * key" — which was measurably false for all three and cost two real bypasses:
 * `merge_rows`' entire API is `survivor_id` + `duplicate_ids`, so a grant minted for
 * 26 NAMED archived records was spent collapsing 26 different ACTIVE ones; and
 * `dedup`'s `fuzzy` decides whether the scan finds nothing or hundreds, so an
 * exact-duplicate approval (which destroyed 0) was spent on a fuzzy pass that
 * destroyed 21 distinct records. An empty key is not "no argument to bind" — it is
 * "every call of this tool on this object authorizes every other".
 *
 * `opts.cleared` / `opts.filter` let the classifier substitute its VALIDATED view of
 * the call for the raw arguments. That is not cosmetic: the raw values are arbitrary
 * model-supplied data, and this key is persisted in the consent row, so without it an
 * injected sentence rides into durable storage on a field documented to carry no
 * model-authored text. Model-supplied identifiers are hashed for the same reason.
 * Callers should read `DestructiveIntent.verbKey` rather than call this directly —
 * the classifier is the one derivation both ends share.
 */
export function verbKey(
  tool: string,
  args: Record<string, unknown>,
  opts: { cleared?: readonly string[]; filter?: readonly unknown[] } = {},
): string {
  switch (tool) {
    case 'delete_entity': {
      const r = args.resolution;
      return `resolution:${r === 'delete_data' || r === 'delete_cascade' ? r : 'none'}`;
    }
    case 'delete_row': {
      // A hard delete is unrecoverable; a soft one is in the trash. Not the same act.
      // The ROW is part of the act too: a grant that bound only "delete 1 record from
      // Notes" was spendable on any record in Notes, so consent minted for one row
      // deleted a different one. The id names which.
      const id = typeof args.id === 'string' ? args.id : '';
      return `hard:${args.hard === true ? 'true' : 'false'}|row:${idKey(id)}`;
    }
    case 'update_row': {
      // The same act as a one-row `bulk_update`, keyed the same way: WHICH fields are
      // cleared, WHICH record, and — see `payloadKey` — the whole write it carries.
      const values = writeMap(args.values);
      const cleared = [...(opts.cleared ?? clearedKeys(values))].sort();
      const id = typeof args.id === 'string' ? args.id : '';
      return `clear:${cleared.join(',')}|row:${idKey(id)}|set:${payloadKey(values)}`;
    }
    case 'bulk_update': {
      // The CLEARED columns are what makes this destructive — setting real values is
      // not destruction. Sorted so argument order cannot change the key.
      const set = writeMap(args.set);
      const cleared = [...(opts.cleared ?? clearedKeys(set))].sort();
      // ...and WHICH rows. Without the filter a grant bound a count and nothing else,
      // so consent shown for one set of 50 records was spent clearing a different 50.
      // ...and the WHOLE payload, because everything in `set` that was not a clear was
      // unbound: an approved clear could carry any number of extra column overwrites.
      return `clear:${cleared.join(',')}|where:${filterKey(opts.filter ?? args.filter)}|set:${payloadKey(set)}`;
    }
    case 'unlink': {
      // The junction ROW is the whole act: `values` names the two ends of the link
      // being cut. Without it, consent to remove one link removed any other.
      return `unlink|edge:${idKey(canonicalJson(args.values))}`;
    }
    case 'merge_rows': {
      // Exactly which records are collapsed, and into which survivor. Deduped and
      // sorted so the order the model listed them in cannot make one act two.
      const survivor = typeof args.survivor_id === 'string' ? args.survivor_id : '';
      const dups = Array.isArray(args.duplicate_ids)
        ? args.duplicate_ids.filter((v): v is string => typeof v === 'string')
        : [];
      const uniq = [...new Set(dups)].sort();
      // The count rides in the clear so a key can be read as a count without being
      // reversible; the ids themselves are hashed.
      return `merge:${String(uniq.length)}|into:${idKey(survivor)}|of:${idKey(uniq.join('␟'))}`;
    }
    case 'dedup': {
      // `fuzzy` is the whole difference between a pass that merges only byte-identical
      // records and one that merges anything a similarity score calls close enough.
      return `dedup:${args.fuzzy === true ? 'fuzzy' : 'exact'}`;
    }
    default:
      return '';
  }
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
 * Exported so a consent record is minted from THE SAME classification the gate
 * runs, never from the model's description of its own plan. Two derivations of
 * "what this call destroys" would be two chances to disagree, and the disagreement
 * would land in favour of whichever one the user was shown.
 *
 * The exported form exists to guarantee ONE property the branches below must never be
 * trusted to remember individually: every `detail` it returns has been through
 * {@link safeDetail}. `detail` becomes a line of the confirmation card, so a branch
 * that interpolates something model-supplied without flattening it is a branch that
 * writes attacker-chosen prose into the confirmation. Enforced here, once.
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
    // one — so the collateral escaped the size threshold, the durable refusal AND the
    // card. Counted here so `rows` is the size of the ACT, not the size of the object.
    const collateral = cascade ? await countCascade(ctx, target) : null;
    const total = collateral ? addCounts(rows, collateral) : rows;
    // The RESOLUTION is the whole difference between "remove the object, keep the
    // records" and "remove it and everything in it, plus everything pointing at it",
    // and the card said neither — every one of them read "remove X (N records)". The
    // grant has always bound the resolution via verbKey, so this is the card catching
    // up with what was actually being authorized.
    const scale = countPhrase(rows);
    return {
      kind: 'remove_object',
      target,
      verbKey: verbKey(name, args),
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
    // honest answer. This is also the gate that keeps model PROSE out of the card:
    // `args.id` is unvalidated model text, and a card line was measured reading
    // "delete record n_1 (a test copy — the real data is untouched, safe) from
    // notes" alongside a real spendable grant. A sentence is not a record.
    if ((await countExisting(ctx, target, [id])) === 0) return null;
    // Names WHICH record. The grant binds it too (see verbKey), so an approval for
    // one row cannot be spent on another — which is what used to happen.
    return {
      kind: 'delete_records',
      target,
      verbKey: verbKey(name, args),
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
      verbKey: verbKey(name, args, { cleared: named }),
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
      verbKey: verbKey(name, args),
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
    // call whose identity is fully known before it runs — which is exactly why the
    // grant must bind it. It did not: `verbKey` returned '' here, so a grant minted
    // for 26 named archived records was spent collapsing 26 different active ones,
    // the tool + target + count all matching.
    const target = typeof args.table === 'string' ? args.table : '';
    const raw = Array.isArray(args.duplicate_ids) ? args.duplicate_ids : null;
    // A malformed call destroys nothing (the handler rejects it) — that error is the
    // handler's to report verbatim, not the gate's to pre-empt with a confirmation.
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
      verbKey: verbKey(name, args),
      rows: real,
      detail:
        `merge ${String(real)} named record(s) into 1 in "${target}"` +
        (shown ? ` (${shown})` : '') +
        ` — only these, and the merged-away records are moved to the trash (recoverable)`,
    };
  }
  if (name === 'dedup') {
    // The duplicate scan is NOT run here. `findTableDuplicates` reads up to
    // DEDUP_MAX_SCAN_ROWS (50k) rows and is the expensive half of the call —
    // running it pre-flight would double the cost of every dedup, and on a cloud
    // that cost is egress. The live row count bounds the loss: a table with N live
    // rows can lose at most N-1 to merging (every group keeps its survivor).
    //
    // That bound is only a true upper bound while the count is a true total. Past
    // DESTRUCTIVE_COUNT_CAP it is NOT — boundedCount stops there, so a 12,000-row
    // table reports 5001 and "up to 5000" is smaller than the real answer, not larger.
    // The comment here used to claim the opposite. Saturation is carried instead of
    // asserted away, and the phrasing becomes a floor.
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    const rows = await countRows(ctx, target);
    const most = rows.n > 0 ? rows.n - 1 : 0;
    // WHICH scan is the whole act, and the card said neither: an exact pass merges
    // only records that are already identical (often none), while a fuzzy pass merges
    // whatever a similarity score calls close enough. Measured, that gap turned an
    // approval which would have destroyed 0 records into 21 destroyed ones. Now the
    // grant binds it (see verbKey) and the sentence names it.
    const fuzzy = args.fuzzy === true;
    return {
      kind: 'delete_records',
      target,
      verbKey: verbKey(name, args),
      rows: most,
      ...(rows.unknown ? { rowsUnknown: true } : {}),
      ...(rows.saturated ? { rowsSaturated: true } : {}),
      detail:
        `merge ${fuzzy ? 'SIMILAR (fuzzy-matched)' : 'exactly identical'} duplicate records in ` +
        `"${target}" (` +
        (rows.unknown
          ? 'record count unknown'
          : rows.saturated
            ? `at least ${String(most)} record(s), possibly far more`
            : `up to ${String(most)} record(s)`) +
        `, chosen by the duplicate scan — the merged-away records are moved to the ` +
        `trash (recoverable))`,
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
  const scoped = filterKey(parsed) !== 'all';
  return {
    kind: 'clear',
    target,
    // Built from the VALIDATED column set AND the VALIDATED clause list, so neither
    // an injected key nor junk padding on a clause can reach the durable consent row
    // or move the comparison key.
    verbKey: verbKey(name, args, { cleared: named, filter: parsed }),
    rows: rows.n,
    // Carried, so an uncountable clear reads as WIDE at the gate and as "record count
    // unknown" on the card — never as a clear of zero records.
    ...(rows.unknown ? { rowsUnknown: true } : {}),
    ...(rows.saturated ? { rowsSaturated: true } : {}),
    // Says WHAT the approval covers, because the grant only enforces a count plus the
    // filter — never a specific list of records. Claiming more precision than the
    // grant enforces is the thing being fixed, so the line claims exactly that much.
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
              ? `NOTHING in "${a.destructive.target}" was merged — the call was refused until the user confirms.`
              : `NOTHING in "${a.destructive.target}" was merged. The call failed: ${firstLine(a.error)}`
            : a.refused
              ? `"${a.destructive.target}" was NOT removed — the call was refused until the user confirms.`
              : `"${a.destructive.target}" was NOT removed. The call failed: ${firstLine(a.error)}`,
          userStatement: merging
            ? a.refused
              ? `Nothing in ${friendly(a.destructive.target)} has been combined — I need your go-ahead first.`
              : `Nothing in ${friendly(a.destructive.target)} could be combined, so it is unchanged.`
            : a.refused
              ? `${friendly(a.destructive.target)} has not been removed — I need your go-ahead first.`
              : `${friendly(a.destructive.target)} could not be removed, so it is still there.`,
          ...(a.refused ? { provisional: true } : {}),
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
 * The consent this turn may spend, as the server recorded it.
 *
 * This replaced a `ConfirmationEvidence` assembled by re-reading the conversation:
 * the question came from a replayed `ask_user` block and the answer from the text of
 * the user's message. Both halves are authored — or steerable — by the model being
 * gated, which is what made consent forgeable four different ways: options the user
 * never chose counted as part of the question, a dashboard title could inject an
 * affirmation into what was read as the user's own words, a singularized word match
 * let "that duplicate contact" authorize the whole Contacts table, and an
 * attachment-only turn left an old question answerable.
 *
 * None of those depend on a mistake in the matching. They follow from deriving
 * authority from a channel the model can write to. So the ledger no longer reads
 * text at all: it is handed grants the SERVER computed from its own pre-flight
 * classification, and it may only spend them.
 */
export interface TurnConsent {
  /** Whether the user affirmed the question this record was minted for. */
  status: 'granted' | 'declined';
  /** What the server authorized, computed by `destructiveIntent` at mint time. */
  grants: readonly ConsentGrant[];
  /**
   * Durably mark one grant spent. MUST return false if it was already spent or the
   * write did not land — the call is allowed only when this returns true, so a
   * crash mid-plan cannot leave a grant reusable.
   */
  spend: (grantIndex: number, by: string) => Promise<boolean>;
}

export interface TurnOutcomeLedgerOptions {
  /** The server's record of what the user authorized, if anything. */
  consent?: TurnConsent | undefined;
  /**
   * What this CONVERSATION has refused and what it has since re-approved — read from
   * the consent store, not from the current request.
   *
   * `consent` only exists on the turn whose message answered a question, because that
   * is the only turn carrying a question id. So a refusal enforced from `consent`
   * alone lasted exactly one turn: the next message re-ran the identical plan and
   * destroyed the records. This is the durable half.
   *
   * `grantedActs` is the ONLY part of this that can open anything, and it opens
   * exactly one act — the one the user was asked about and said yes to. Everything
   * else here closes the gate.
   */
  refusals?: ThreadRefusals | undefined;
}

/**
 * The per-turn record of what the tools actually did, the pre-flight gate on
 * multi-target destruction, and the reconciliation the final answer is measured
 * against.
 *
 * One instance per assistant turn. The chat loop hands it to every
 * {@link executeFunction} call, injects {@link reconciliation} into the model's
 * context before the answer round, and emits {@link userNotice} on the stream so
 * the truth reaches the user even if the answer never mentions it. A turn the user
 * STOPS never reaches an answer at all — {@link markStopped} is what makes the
 * notice cover it, since that is the turn most likely to leave changes behind.
 */
export class TurnOutcomeLedger {
  private readonly attempts: ToolAttempt[] = [];
  /** The server's record of what the user authorized this turn, if anything. */
  private readonly consent: TurnConsent | undefined;
  /** What this conversation has refused (and since re-approved), across every turn. */
  private readonly refusals: ThreadRefusals;
  /** Targets a grant has been SPENT on this turn — the only thing that counts as
   *  consented. Tracked here because a multi-target plan gates on the whole set. */
  private readonly spentTargets = new Set<string>();
  /** Args of the call currently being gated, so verbKey is derived from the real
   *  arguments rather than re-parsed from anything. */
  private currentArgs: Record<string, unknown> | undefined;
  /** The shape of each destructive target seen this turn, so a plan that only
   *  becomes gate-worthy on a LATER call can still be matched against what the user
   *  approved for the earlier one. */
  private readonly seen = new Map<
    string,
    { rows: number; unknown: boolean; verb: string; tool: string }
  >();
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
   * slipping under the threshold round after round and never need an answer.
   */
  private plannedRows = 0;
  /** Set when the user stops the turn, so the notice can report the interruption. */
  private stopped = false;

  constructor(opts: TurnOutcomeLedgerOptions = {}) {
    this.consent = opts.consent;
    this.refusals = opts.refusals ?? { targets: new Set<string>(), grantedActs: new Set<string>() };
  }

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
   * Has the user AGREED to destroying `target`? Only an affirmative REPLY to a
   * question the assistant asked about removing that exact thing counts. Not a
   * mention of it, not the question on its own, not an agreement given after their
   * turn to answer it had passed, and not the absence of a refusal: silence, a
   * change of subject, and an ambiguous reply are all "no answer yet".
   *
   * `known` is every object that exists, so the question has to have named THIS
   * one — not one whose name merely contains its words.
   */
  private consented(target: string): boolean {
    return this.spentTargets.has(target);
  }

  /**
   * Find a grant that authorizes exactly this call, and spend it.
   *
   * Every part of the comparison is an identifier or a number the SERVER derived, so
   * there is nothing here for the model to phrase its way past:
   *
   *  - `target` is compared EXACTLY. The old matcher compared singularized words, so
   *    a question about "that duplicate contact" named the whole `contacts` table.
   *  - `verbKey` must match, so agreeing to remove an object but keep its data does
   *    not authorize a cascade.
   *  - `rows` must be within the bound the user was shown. The count is measured at
   *    mint time and the table can grow before the call lands; they consented to an
   *    upper bound, and exceeding it means asking again. An unknown count can never
   *    satisfy a bound.
   *
   * Spending is durable and happens BEFORE the destructive call runs — a grant that
   * cannot be marked spent does not authorize anything, so a crash mid-plan cannot
   * leave it reusable.
   */
  private async spendFor(target: string): Promise<boolean> {
    const consent = this.consent;
    const shape = this.seen.get(target);
    if (consent?.status !== 'granted' || !shape) return false;
    const i = consent.grants.findIndex(
      (g) =>
        !g.spentAt &&
        // The TOOL is part of the act. `verbKey` is empty for unlink, merge_rows and
        // dedup, so without this they authorize one another: consent to a
        // scan-chosen dedup executed a hand-picked merge_rows of 40 unrelated rows.
        g.tool === shape.tool &&
        g.target === target &&
        g.verbKey === shape.verb &&
        !shape.unknown &&
        shape.rows <= g.maxRows,
    );
    if (i === -1) return false;
    if (!(await consent.spend(i, target))) return false;
    this.spentTargets.add(target);
    return true;
  }

  /**
   * True when this conversation refused something about THIS object, and has not since
   * been asked again about the exact act this call performs.
   *
   * Three sources, only one of which can open anything. `refusals.targets` is the
   * conversation's own history, read from the consent store — without it a refusal
   * expired the moment the user typed anything else, which is precisely the window a
   * plan gets chipped away in. `consent` is the answer this turn's message carried, if
   * any. And `refusals.grantedActs` is the single exception: the user was asked about
   * THIS act — this object, this tool, this verb — and said yes.
   *
   * That exception is what keeps a refusal from being a life sentence on an object,
   * and pinning it to the ACT is what stops it being a pardon for everything else: the
   * verdict used to be tracked per TARGET, so a later yes about one small record
   * silently lifted an earlier no about destroying the whole object.
   */
  private refusedTarget(target: string): boolean {
    const shape = this.seen.get(target);
    if (shape && this.refusals.grantedActs.has(consentActKey(target, shape.tool, shape.verb))) {
      return false;
    }
    if (this.refusals.targets.has(target)) return true;
    const consent = this.consent;
    if (consent?.status !== 'declined') return false;
    return consent.grants.some((g) => g.target === target);
  }

  /**
   * Why the plan is not confirmed, in the terms the model has to act on.
   *
   * Each branch names the ONE thing that would change the outcome. Vague refusals
   * are how a model ends up looping: it re-asks the same question, gets refused
   * again, and the user watches it fail twice.
   */
  private consentGap(unconfirmed: readonly string[]): string {
    const consent = this.consent;
    const names = unconfirmed.map((t) => `"${t}"`).join(', ');
    // A refusal recorded EARLIER in the conversation is still a refusal. Said first,
    // because otherwise the branch below tells the model it was "not asked about
    // this" — which contradicts the reason it was just given and reads as an
    // invitation to try the same call again.
    const refused = unconfirmed.filter((t) => this.refusedTarget(t));
    if (refused.length > 0) {
      return (
        `The user was asked about ${refused.map((t) => `"${t}"`).join(', ')} in this conversation ` +
        `and said no, so treat this plan as declined. Do not retry it. If they have since changed ` +
        `their mind, ask again with ask_user and a "confirm" naming the calls you intend to make — ` +
        `only a NEW answer can lift a refusal.`
      );
    }
    if (!consent) {
      return (
        `The user has not been asked about this. Ask with ask_user, and pass the calls you intend ` +
        `to make as its "confirm" argument — that is what records their answer. A question asked ` +
        `without it cannot authorize anything, however it is worded.`
      );
    }
    if (consent.status === 'declined') {
      return `The user was asked and said no, so treat this plan as declined until they raise it again.`;
    }
    const unspent = consent.grants.filter((g) => !g.spentAt);
    if (unspent.length === 0) {
      return (
        `What the user agreed to has already been carried out. Doing it again needs a fresh ` +
        `question — consent covers one act, not a standing permission.`
      );
    }
    return (
      `What the user agreed to does not cover this: ${names}. They approved ` +
      `${unspent.map((g) => `"${g.target}" (${g.detail})`).join('; ')}. ` +
      `Ask again with a "confirm" that matches what you actually intend to do — including the ` +
      `same removal kind and no more records than you named.`
    );
  }

  /**
   * PRE-FLIGHT GATE. Returns an instructive refusal when this call is part of a
   * destructive plan the user has not agreed to — one that spans more than one
   * object, one that has grown wider than the unasked threshold ACROSS the turn,
   * or one they have already refused (at any size) — otherwise null. Enforced as a
   * rejected tool call, not as a prompt rule, because a prompt rule is exactly what
   * failed here.
   */
  async gateDestructive(
    ctx: DispatchCtx,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const intent = await destructiveIntent(ctx, name, args);
    if (!intent) return null;
    this.intents.set(args, intent);
    this.currentArgs = args;
    this.seen.set(intent.target, {
      rows: intent.rows,
      unknown: intent.rowsUnknown === true,
      // The classifier's own key, not a second derivation of it — see
      // DestructiveIntent.verbKey.
      verb: intent.verbKey,
      tool: name,
    });

    const targets = new Map(this.touched);
    targets.set(intent.target, Math.max(targets.get(intent.target) ?? 0, intent.rows));
    const totalRows = this.plannedRows + intent.rows;
    const multiTarget = targets.size > 1;
    const wide = totalRows > DESTRUCTIVE_ROW_THRESHOLD || intent.rowsUnknown === true;
    // A plan the user has REFUSED is gated at any size: chipping away at it one
    // small call at a time is the same plan, and the size screen would wave every
    // one of those through. Narrow on purpose — it only applies when they were
    // asked about removing THIS object and said no.
    const refused = this.refusedTarget(intent.target);
    if (!multiTarget && !wide && !refused) return null;

    // Spend a grant for every target in the plan that does not have one yet.
    //
    // Every target is resolved here, not just the current call's, because a plan can
    // become gate-worthy only on a LATER call: two single-object removals are each
    // below the threshold and pass individually, and it is the second one that makes
    // it multi-target. The first was allowed without spending anything, so unless its
    // grant is claimed now it would read as unapproved and refuse a plan the user
    // did approve.
    const unconfirmed: string[] = [];
    if (!refused) {
      for (const t of targets.keys()) {
        // THIS call always has to pay for itself. Skipping the match because the
        // target was paid for earlier in the turn is what turned one approval into a
        // blanket licence: after a legitimate spend, every later call on the same
        // table bypassed the tool, verb and row-bound checks entirely — so agreeing
        // to "clear a column on 60 rows" also bought unlimited hard deletes and a
        // cascading drop of the object. A target is not a permission; a grant is,
        // and each act consumes one.
        if (t !== intent.target && this.consented(t)) continue;
        if (!(await this.spendFor(t))) unconfirmed.push(t);
      }
    } else {
      unconfirmed.push(...[...targets.keys()].filter((t) => !this.consented(t)));
    }
    if (unconfirmed.length === 0) return null;

    const already = [...this.touched].map(([t, n]) => `"${t}" (${String(n)} record(s))`);
    const reason = multiTarget
      ? `it removes from more than one object: ${[...targets]
          .map(([t, n]) => `"${t}" (${String(n)} record(s))`)
          .join(', ')}`
      : wide
        ? `this turn's destructive work now reaches ${intent.rowsUnknown === true ? 'an unknown number of' : String(totalRows)} records in total, more than the ${String(DESTRUCTIVE_ROW_THRESHOLD)} this can do unasked`
        : `the user was asked about removing "${intent.target}" and said no — size does not make it allowed`;
    return (
      `REFUSED — nothing was changed by this call. This is part of a destructive plan the user has ` +
      `not agreed to: ${reason}.\n` +
      `About to: ${intent.detail}.\n` +
      (already.length > 0 ? `Already acted on this turn: ${already.join(', ')}.\n` : '') +
      `${this.consentGap(unconfirmed)}\n` +
      `Call ask_user FIRST. The question must name every one of these — by the name the user sees, ` +
      `with its record count — and ask plainly whether to remove them. Their next message has to be ` +
      `an explicit yes to THAT question; anything else leaves this refused. Retry only after they ` +
      `answer. Do not retry this call before asking, and never describe any of it as done.`
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
