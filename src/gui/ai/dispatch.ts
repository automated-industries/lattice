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
  isWriteConflict,
} from './handlers/row-mutations.js';
import { parseBulkFilters } from './handlers/row-mutations.js';

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
/** Cap for the gate's pre-flight counts — bounded, SQL-side, never a table scan. */
const DESTRUCTIVE_COUNT_CAP = 5000;
/** A `spec`-authored document shorter than this was very likely never really written. */
const MIN_AUTHORED_ARTIFACT_CHARS = 200;

/** Tools that remove or clear data. Adding one here is the whole registration. */
const REMOVAL_TOOLS: ReadonlySet<string> = new Set([
  'delete_entity',
  'delete_row',
  'unlink',
  'bulk_update',
]);

export interface DestructiveIntent {
  kind: 'remove_object' | 'delete_records' | 'unlink' | 'clear';
  /** The object (table) being destroyed — the identity a plan's size counts. */
  target: string;
  /** Best-effort pre-flight count of records this call affects. */
  rows: number;
  /** True when the count could not be established (treated as wide, never as 0). */
  rowsUnknown?: boolean;
  /** One phrase naming this call's exact target + count, for the refusal text. */
  detail: string;
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

function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singular);
}

/** Every window in `hay` where `needle`'s words appear consecutively, in order. */
function spansOf(hay: readonly string[], needle: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  if (needle.length === 0 || needle.length > hay.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) out.push([i, i + needle.length - 1]);
  }
  return out;
}

/**
 * True when `evidence` — the question the USER was actually shown — names `target`,
 * and names THAT object rather than some other one it shares words with.
 *
 * Tolerant about spelling, strict about identity. The assistant is required to
 * speak to the user in friendly names, never raw internal ones, so
 * `q3_invoice_lines` has to match a question that said "Q3 Invoice Lines" — the
 * comparison is on words, singularized, in order, as an unbroken run.
 *
 * `known` is every object that exists, and is what makes the match exact rather
 * than merely contiguous. Matching on a SUBSET of the question's words let an
 * agreement to remove a compound-named object authorize removing a different one
 * whose whole name is a word of it: a yes to "Remove Customer Invoices?" also
 * unlocked "Customers" and "Invoices", which the user never agreed to and may not
 * even have realized existed. So a run is only a naming of `target` when no
 * LONGER real object name covers that same run — when "customer invoice" is
 * itself an object, the word "customer" inside it is part of that name, not a
 * separate mention of another one. Naming both for real still matches both.
 *
 * A target the question never named does not match and the gate stays closed,
 * which is the safe direction to be wrong in.
 */
export function namedIn(evidence: string, target: string, known: Iterable<string> = []): boolean {
  const want = wordsOf(target);
  if (want.length === 0) return false;
  const said = wordsOf(evidence);
  const hits = spansOf(said, want);
  if (hits.length === 0) return false;
  // Where a longer object's name occupies the question's words. A name can only be
  // absorbed by a strictly longer one.
  const covered: [number, number][] = [];
  for (const other of known) {
    if (other === target) continue;
    const w = wordsOf(other);
    // Two different objects that read the same to the user: the question cannot
    // have named one of them in particular, so it named neither.
    if (w.join(' ') === want.join(' ')) return false;
    if (w.length <= want.length) continue;
    covered.push(...spansOf(said, w));
  }
  return hits.some(([from, to]) => !covered.some(([a, b]) => a <= from && to <= b));
}

/**
 * The one exchange that can authorize destruction: a question the assistant put to
 * the user, and their answer to it.
 *
 * Consent is an ANSWER, never a word that happened to appear. Matching the target's
 * name anywhere in the conversation made two forgeries possible: a user MENTIONING
 * an object (usually while asking about it) satisfied the confirmation for
 * destroying it, and the assistant's own question supplied the names — so the model
 * could manufacture the evidence that unlocked its own destructive call. Assembled
 * by the chat loop; absent → nothing is confirmed.
 *
 * An answer is also a REPLY, never just a later agreement. `question` therefore
 * carries only a question this message can still be answering — one the user has
 * not already had a turn after. Left live, a removal question asked much earlier
 * stayed answerable forever, and any later message that merely opened
 * affirmatively ("yes, do that" — about something else entirely) reactivated it.
 */
export interface ConfirmationEvidence {
  /**
   * The question this message is answering: the last one the assistant asked, as
   * the user saw it (with its options), and only while it is still the user's turn
   * to answer it. Blank once their turn has come and gone.
   */
  question: string;
  /** True only when the user's reply to that question is an explicit yes. */
  affirmed: boolean;
  /** True when the user's reply reads as a refusal. */
  declined: boolean;
  /** True when a question WAS asked but the user has since had a turn — see above. */
  stale?: boolean;
  /**
   * The last question asked at any point, live or spent. Read ONLY to understand a
   * refusal ("they are saying no, and this is what they were last asked about"),
   * which can only ever close the gate further — never to grant consent.
   */
  lastQuestion?: string;
}

/**
 * True when a question is asking the user to agree to a REMOVAL, rather than merely
 * mentioning the thing. A yes to "add a field to Contacts and Deals?" names both
 * objects but agrees to nothing destructive, so the question has to be about
 * destruction before an answer to it can unlock any.
 */
export function asksToDestroy(question: string): boolean {
  return /\b(remove|removing|delete|deleting|drop|dropping|clear|clearing|wipe|wiping|erase|erasing|unlink|unlinking|discard|discarding|purge|purging)\b/i.test(
    question,
  );
}

/** Bounded, SQL-side count of live records in a table. Never throws. */
async function countRows(
  ctx: DispatchCtx,
  table: string,
): Promise<{ n: number; unknown: boolean }> {
  try {
    const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
      cap: DESTRUCTIVE_COUNT_CAP,
    };
    if (ctx.softDeletable.has(table)) {
      opts.filters = [{ col: 'deleted_at', op: 'isNull' }];
    }
    return { n: await ctx.db.boundedCount(table, opts), unknown: false };
  } catch (e) {
    // Loud, never silent: an uncountable target is treated as WIDE (needs
    // confirmation), never as "0 records, go ahead".
    console.warn(`[assistant] could not pre-count "${table}": ${(e as Error).message}`);
    return { n: 0, unknown: true };
  }
}

/**
 * Classify a call as destructive and measure its blast radius BEFORE it runs.
 * Returns null for anything that destroys nothing — including a `delete_entity`
 * with no resolution on a non-empty object (that call only reports what is in the
 * way) and a `move_to` merge (reversible by design, and the model is told so).
 */
async function destructiveIntent(
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
    const resolved = args.resolution === 'delete_data' || args.resolution === 'delete_cascade';
    // No resolution + records present ⇒ the call reports what is in the way and
    // removes nothing, so there is nothing to gate yet.
    if (!resolved && rows.n > 0 && !rows.unknown) return null;
    return {
      kind: 'remove_object',
      target,
      rows: rows.n,
      ...(rows.unknown ? { rowsUnknown: true } : {}),
      detail: `remove "${target}" (${rows.unknown ? 'record count unknown' : `${String(rows.n)} record(s)`})`,
    };
  }
  if (name === 'delete_row') {
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    return {
      kind: 'delete_records',
      target,
      rows: 1,
      detail: `delete 1 record from "${target}"${args.hard === true ? ' permanently' : ''}`,
    };
  }
  if (name === 'unlink') {
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    return { kind: 'unlink', target, rows: 1, detail: `remove 1 link from "${target}"` };
  }
  // bulk_update is destructive only when it CLEARS values — the "unlink 40 rows
  // to make a delete possible" move. Setting real values is an ordinary edit.
  const target = typeof args.table === 'string' ? args.table : '';
  if (!target || !args.set || typeof args.set !== 'object') return null;
  const set = args.set as Record<string, unknown>;
  const cleared = Object.keys(set).filter((k) => set[k] === null || set[k] === '');
  if (cleared.length === 0) return null;
  let rows: { n: number; unknown: boolean };
  try {
    const filters = parseBulkFilters(args.filter, target, ctx.db);
    if (ctx.softDeletable.has(target)) filters.push({ col: 'deleted_at', op: 'isNull' });
    const opts: NonNullable<Parameters<typeof ctx.db.boundedCount>[1]> = {
      cap: DESTRUCTIVE_COUNT_CAP,
    };
    opts.filters = filters as NonNullable<typeof opts.filters>;
    rows = { n: await ctx.db.boundedCount(target, opts), unknown: false };
  } catch {
    // An invalid filter is the handler's error to report, verbatim — not the
    // gate's to pre-empt with a confirmation demand.
    return null;
  }
  return {
    kind: 'clear',
    target,
    rows: rows.n,
    detail: `clear ${cleared.map((c) => `"${c}"`).join(', ')} on ${String(rows.n)} record(s) in "${target}"`,
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
        out.push({
          axis: 'destructive',
          kind: 'not_done',
          key: `destructive:not_done:${a.name}:${a.destructive.target}`,
          statement: a.refused
            ? `"${a.destructive.target}" was NOT removed — the call was refused until the user confirms.`
            : `"${a.destructive.target}" was NOT removed. The call failed: ${firstLine(a.error)}`,
          userStatement: a.refused
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

export interface TurnOutcomeLedgerOptions {
  /** What the user has been shown/said that could confirm a destructive plan. */
  evidence?: ConfirmationEvidence;
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
  private readonly evidence: ConfirmationEvidence;
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
    this.evidence = opts.evidence ?? { question: '', affirmed: false, declined: false };
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
  private consented(target: string, known: Iterable<string>): boolean {
    const { question, affirmed, declined } = this.evidence;
    if (declined || !affirmed || question === '') return false;
    if (!asksToDestroy(question)) return false;
    return namedIn(question, target, known);
  }

  /**
   * True when the user was asked about removing THIS object and answered no. Read
   * against the last question asked at any point: a refusal only ever closes the
   * gate, so an older question can be honoured here without loosening anything.
   */
  private refusedTarget(target: string, known: Iterable<string>): boolean {
    const { question, lastQuestion, declined } = this.evidence;
    const asked = lastQuestion ?? question;
    return declined && asked !== '' && asksToDestroy(asked) && namedIn(asked, target, known);
  }

  /** Why the plan is not confirmed, in the terms the model has to act on. */
  private consentGap(unconfirmed: readonly string[]): string {
    const { question, affirmed, declined, stale } = this.evidence;
    if (declined) {
      return `The user's last message reads as a refusal, so treat this plan as declined until they say otherwise.`;
    }
    if (question === '') {
      return stale === true
        ? `A question was put to the user earlier in this conversation, but they have taken a turn ` +
            `since — that moment has passed and their agreement now is to whatever was last said, not ` +
            `to that. An old yes never carries forward; ask again, now.`
        : `The user has not been asked about this at all.`;
    }
    if (!affirmed) {
      return (
        `The user was asked, but their reply was not a clear yes. An unrelated, ambiguous, or ` +
        `absent answer is NOT consent — only an explicit yes is.`
      );
    }
    if (!asksToDestroy(question)) {
      return (
        `The question they agreed to was not about removing anything, so their answer does not ` +
        `cover this.`
      );
    }
    return (
      `Their answer only covers what that question named; ` +
      `${unconfirmed.map((t) => `"${t}"`).join(', ')} was not part of it.`
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

    const targets = new Map(this.touched);
    targets.set(intent.target, Math.max(targets.get(intent.target) ?? 0, intent.rows));
    const totalRows = this.plannedRows + intent.rows;
    const multiTarget = targets.size > 1;
    const wide = totalRows > DESTRUCTIVE_ROW_THRESHOLD || intent.rowsUnknown === true;
    // A plan the user has REFUSED is gated at any size: chipping away at it one
    // small call at a time is the same plan, and the size screen would wave every
    // one of those through. Narrow on purpose — it only applies when they were
    // asked about removing THIS object and said no.
    const refused = this.refusedTarget(intent.target, ctx.validTables);
    if (!multiTarget && !wide && !refused) return null;

    const unconfirmed = [...targets.keys()].filter((t) => !this.consented(t, ctx.validTables));
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
