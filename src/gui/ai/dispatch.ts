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
import type { ConsentGrant } from './consent-store.js';

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
  /** One phrase naming this call's exact target + count, for the refusal text. */
  detail: string;
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
 * nothing else. Tools whose destruction has no such argument key to `''` — their
 * identity is carried by the grant's `tool` field, which is compared alongside.
 */
export function verbKey(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'delete_entity': {
      const r = args.resolution;
      return `resolution:${r === 'delete_data' || r === 'delete_cascade' ? r : 'none'}`;
    }
    case 'delete_row':
      // A hard delete is unrecoverable; a soft one is in the trash. Not the same act.
      return `hard:${args.hard === true ? 'true' : 'false'}`;
    case 'bulk_update': {
      // Only the CLEARED columns matter — setting real values is not destruction.
      // Sorted so argument order cannot change the key.
      const set =
        args.set && typeof args.set === 'object' ? (args.set as Record<string, unknown>) : {};
      const cleared = Object.keys(set)
        .filter((k) => set[k] === null || set[k] === '')
        .sort();
      return `clear:${cleared.join(',')}`;
    }
    case 'unlink':
    case 'merge_rows':
    case 'dedup':
      return '';
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
 *
 * Exported so a consent record is minted from THE SAME classification the gate
 * runs, never from the model's description of its own plan. Two derivations of
 * "what this call destroys" would be two chances to disagree, and the disagreement
 * would land in favour of whichever one the user was shown.
 */
export async function destructiveIntent(
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
  if (name === 'merge_rows') {
    // Exact and free: the call names the rows it will collapse, so the blast radius
    // is the length of that list — no pre-flight query needed at all.
    const target = typeof args.table === 'string' ? args.table : '';
    const ids = Array.isArray(args.duplicate_ids) ? args.duplicate_ids : null;
    // A malformed call destroys nothing (the handler rejects it) — that error is the
    // handler's to report verbatim, not the gate's to pre-empt with a confirmation.
    if (!target || !ids || ids.length === 0) return null;
    return {
      kind: 'delete_records',
      target,
      rows: ids.length,
      detail:
        `merge ${String(ids.length)} record(s) into 1 in "${target}" — the merged-away ` +
        `records are moved to the trash (recoverable)`,
    };
  }
  if (name === 'dedup') {
    // The duplicate scan is NOT run here. `findTableDuplicates` reads up to
    // DEDUP_MAX_SCAN_ROWS (50k) rows and is the expensive half of the call —
    // running it pre-flight would double the cost of every dedup, and on a cloud
    // that cost is egress. The live row count is already a true upper bound: a
    // table with N live rows can lose at most N-1 to merging (every group keeps
    // its survivor). Bounded, SQL-side, and never smaller than the real answer.
    const target = typeof args.table === 'string' ? args.table : '';
    if (!target) return null;
    const rows = await countRows(ctx, target);
    const most = rows.n > 0 ? rows.n - 1 : 0;
    return {
      kind: 'delete_records',
      target,
      rows: most,
      ...(rows.unknown ? { rowsUnknown: true } : {}),
      detail:
        `merge duplicate records in "${target}" (` +
        (rows.unknown ? 'record count unknown' : `up to ${String(most)} record(s)`) +
        `, chosen by the duplicate scan — the merged-away records are moved to the ` +
        `trash (recoverable))`,
    };
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
  /** Targets a grant has been SPENT on this turn — the only thing that counts as
   *  consented. Tracked here because a multi-target plan gates on the whole set. */
  private readonly spentTargets = new Set<string>();
  /** Args of the call currently being gated, so verbKey is derived from the real
   *  arguments rather than re-parsed from anything. */
  private currentArgs: Record<string, unknown> | undefined;
  /** The shape of each destructive target seen this turn, so a plan that only
   *  becomes gate-worthy on a LATER call can still be matched against what the user
   *  approved for the earlier one. */
  private readonly seen = new Map<string, { rows: number; unknown: boolean; verb: string }>();
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
   * True when the user was asked about removing THIS object and answered no. Read
   * against the last question asked at any point: a refusal only ever closes the
   * gate, so an older question can be honoured here without loosening anything.
   */
  private refusedTarget(target: string): boolean {
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
      verb: verbKey(name, args),
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
        if (this.consented(t)) continue;
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
