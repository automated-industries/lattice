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

/** One axis of "what is the answer about to claim, and is it true". */
export interface ClaimVerifier {
  axis: string;
  /** Pure over the turn's attempts — no I/O, so it can run after every round. */
  facts(attempts: readonly ToolAttempt[]): OutcomeFact[];
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

/**
 * True when `evidence` — text the USER actually saw or wrote — names `target`.
 *
 * Deliberately tolerant: the assistant is required to speak to the user in
 * friendly names, never raw internal ones, so `q3_invoice_lines` has to match a
 * question that said "Q3 Invoice Lines". Matching is on words, singularized, all
 * of which must be present. A target the user was never shown simply does not
 * match, and the gate stays closed — which is the safe direction.
 */
export function namedIn(evidence: string, target: string): boolean {
  const words = wordsOf(target);
  if (words.length === 0) return false;
  const seen = new Set(wordsOf(evidence));
  return words.every((w) => seen.has(w));
}

/**
 * What the user has been shown (or has said) that could count as consent for a
 * destructive plan, plus whether their latest message reads as a refusal.
 * Assembled by the chat loop from the conversation; absent → nothing is confirmed.
 */
export interface ConfirmationEvidence {
  text: string;
  declined: boolean;
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
  facts(attempts) {
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
    if (out.length === 0) return out;
    // Half-applied plan: something was destroyed to enable a removal that then
    // did not happen. That residue is the damage the user must hear about.
    const done = attempts.filter(
      (a) =>
        a.ok &&
        a.destructive &&
        (a.destructive.kind === 'unlink' || a.destructive.kind === 'clear'),
    );
    if (done.length > 0) {
      const rows = done.reduce((n, a) => n + affectedRows(a), 0);
      const objects = [...new Set(done.map((a) => a.destructive?.target ?? ''))].filter(Boolean);
      const names = objects.map(friendly).join(', ');
      out.push({
        axis: 'destructive',
        kind: 'residue',
        key: 'destructive:residue',
        statement:
          `${String(rows)} record(s) across ${String(objects.length)} object(s) (${objects.join(', ')}) ` +
          `WERE unlinked/cleared to make that removal possible, and those changes are still applied. ` +
          `The workspace is now half-changed: links gone, objects still present.`,
        userStatement:
          `${String(rows)} record(s) in ${names} were already unlinked to prepare for that, and those ` +
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
 * the truth reaches the user even if the answer never mentions it.
 */
export class TurnOutcomeLedger {
  private readonly attempts: ToolAttempt[] = [];
  private readonly evidence: ConfirmationEvidence;
  /** Pre-flight classifications, keyed by the (unique) args object of the call. */
  private readonly intents = new WeakMap<object, DestructiveIntent>();
  /** Destructive targets already acted on this turn → records at stake, for the
   *  refusal text. Its size is the plan's size so far. */
  private readonly touched = new Map<string, number>();
  private destroyedRows = 0;

  constructor(opts: TurnOutcomeLedgerOptions = {}) {
    this.evidence = opts.evidence ?? { text: '', declined: false };
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
   * multi-target destructive plan (or a single wide one) the user has not been
   * asked about — otherwise null. Enforced as a rejected tool call, not as a
   * prompt rule, because a prompt rule is exactly what failed here.
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
    const totalRows = this.destroyedRows + intent.rows;
    const multiTarget = targets.size > 1;
    const wide = totalRows > DESTRUCTIVE_ROW_THRESHOLD || intent.rowsUnknown === true;
    if (!multiTarget && !wide) return null;

    const unnamed = [...targets.keys()].filter((t) => !namedIn(this.evidence.text, t));
    if (!this.evidence.declined && unnamed.length === 0) return null;

    const already = [...this.touched].map(([t, n]) => `"${t}" (${String(n)} record(s))`);
    const reason = multiTarget
      ? `it removes from more than one object: ${[...targets]
          .map(([t, n]) => `"${t}" (${String(n)} record(s))`)
          .join(', ')}`
      : `it affects ${intent.rowsUnknown === true ? 'an unknown number of' : String(totalRows)} records, more than the ${String(DESTRUCTIVE_ROW_THRESHOLD)} this can do unasked`;
    return (
      `REFUSED — nothing was changed by this call. This is part of a destructive plan the user has ` +
      `not agreed to: ${reason}.\n` +
      `About to: ${intent.detail}.\n` +
      (already.length > 0 ? `Already acted on this turn: ${already.join(', ')}.\n` : '') +
      (this.evidence.declined
        ? `The user's last message reads as a refusal, so treat this plan as declined until they say otherwise.\n`
        : '') +
      `Call ask_user FIRST. The question must name every one of these — by the name the user sees, ` +
      `with its record count — and ask whether to go ahead. Retry only after they answer. Do not ` +
      `retry this call before asking, and never describe any of it as done.`
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
      // The target counts toward the plan's size whether or not the call landed —
      // an attempted removal is still part of the plan the user must agree to.
      this.touched.set(intent.target, Math.max(this.touched.get(intent.target) ?? 0, intent.rows));
      if (res.ok) this.destroyedRows += affectedRows(attempt);
    }
  }

  /** Every fact the registered axes can prove about this turn, deduped by key. */
  facts(): OutcomeFact[] {
    const byKey = new Map<string, OutcomeFact>();
    for (const v of CLAIM_VERIFIERS) {
      for (const f of v.facts(this.attempts)) byKey.set(f.key, f);
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
