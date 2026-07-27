import { normalizeName } from '../import/infer-core.js';
import { isAnonymousName } from '../import/name-policy.js';

/**
 * The star-schema validity contract: the conditions a proposed table must meet
 * before it is allowed into the model.
 *
 * This layers on the shared table-name policy (`import/name-policy.ts`) rather
 * than restating it — the name predicate stays the single source of truth for
 * "what counts as an anonymous table", and this module adds the SHAPE questions
 * that a name check cannot answer: is the thing actually tabular, is it
 * populated, does one row mean one repeatable instance, and is it distinct from
 * everything already in the model.
 *
 * The check returns a result PER CONDITION rather than a bare boolean, so a
 * caller can tell the user which condition failed ("only one column") instead of
 * an unexplained "skipped". Pure and dependency-free: no DB, no model, no I/O.
 */

/** Fewest distinct columns a table must expose. One column is a list, not a table. */
export const MIN_TABLE_COLUMNS = 2;

/** Fewest data rows a table must carry. One row is a fact, not a dataset. */
export const MIN_TABLE_ROWS = 2;

export type StarSchemaConditionId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5';

export type StarSchemaConditionName =
  | 'named'
  | 'tabular'
  | 'populated'
  | 'stable-grain'
  | 'distinct';

export interface StarSchemaCondition {
  id: StarSchemaConditionId;
  name: StarSchemaConditionName;
  ok: boolean;
  /** Human-readable explanation. Present only when the condition failed. */
  reason?: string;
}

/** A table an import (or the assistant) proposes adding to the model. */
export interface ModelTableCandidate {
  /** The proposed table name, as the user would see it. */
  name: string;
  /**
   * Every column the table will EXPOSE — including fields that inference
   * normalizes out into dimensions or link columns. Callers that check a
   * post-inference entity must add those back, or a legitimate table whose
   * categoricals were extracted looks one column wide.
   */
  columns: string[];
  rowCount: number;
  /** Natural-key column, or null when the grain is a surrogate id + content hash. */
  naturalKey?: string | null;
  /** False when the parsed rows do not share one column set (a ragged extraction). */
  uniformColumns?: boolean;
}

export interface StarSchemaContractResult {
  ok: boolean;
  /** The candidate's name, echoed so a caller can report without re-threading it. */
  name: string;
  conditions: StarSchemaCondition[];
  /** Ids of the conditions that failed, in C1..C5 order. Empty when `ok`. */
  failed: StarSchemaConditionId[];
  /** One line naming the failing conditions and why. '' when `ok`. */
  reason: string;
  /** True when the table is already in the model and the gate was skipped. */
  exempt: boolean;
}

export interface ContractOptions {
  /**
   * Names the candidate must be distinct FROM — the other tables in the same
   * plan plus anything already in the workspace. Compared under normalization,
   * because that is what actually collides at create time.
   */
  siblingNames?: Iterable<string>;
  /** Column floor for C2. Defaults to {@link MIN_TABLE_COLUMNS}. */
  minColumns?: number;
  /** Row floor for C3. Defaults to {@link MIN_TABLE_ROWS}. */
  minRows?: number;
}

/**
 * True when `name` carries no meaning to the user — `Table 1`, `Sheet3`,
 * `untitled`. Thin wrapper over the shared name policy, which is stated in terms
 * of the NORMALIZED identifier; this takes the raw display name so callers do
 * not each have to remember to normalize first (forgetting that is how `Table 1`
 * slipped through before).
 */
export function isGenericTableName(name: string): boolean {
  return isAnonymousName(normalizeName(name));
}

const CONDITION_NAMES: Record<StarSchemaConditionId, StarSchemaConditionName> = {
  C1: 'named',
  C2: 'tabular',
  C3: 'populated',
  C4: 'stable-grain',
  C5: 'distinct',
};

/** Evaluate all five conditions. Every condition is evaluated — the result lists
 *  each one, so a caller sees the complete picture rather than the first failure. */
export function checkStarSchemaContract(
  candidate: ModelTableCandidate,
  opts: ContractOptions = {},
): StarSchemaContractResult {
  const minColumns = opts.minColumns ?? MIN_TABLE_COLUMNS;
  const minRows = opts.minRows ?? MIN_TABLE_ROWS;
  const distinctColumns = new Set(candidate.columns.map((c) => normalizeName(c)));
  distinctColumns.delete('');
  const siblings = new Set<string>();
  for (const s of opts.siblingNames ?? []) siblings.add(normalizeName(s));
  const normalized = normalizeName(candidate.name);

  const conditions: StarSchemaCondition[] = [
    verdict(
      'C1',
      !isGenericTableName(candidate.name),
      () => `"${candidate.name}" is a positional or placeholder name, not a name for a table`,
    ),
    verdict(
      'C2',
      distinctColumns.size >= minColumns,
      () =>
        `"${candidate.name}" has ${String(distinctColumns.size)} distinct column(s); a table needs at least ${String(minColumns)}`,
    ),
    verdict(
      'C3',
      candidate.rowCount >= minRows,
      () =>
        `"${candidate.name}" has ${String(candidate.rowCount)} row(s); a table needs at least ${String(minRows)}`,
    ),
    verdict(
      'C4',
      Boolean(candidate.naturalKey) || candidate.uniformColumns !== false,
      () =>
        `"${candidate.name}" has no natural key and its rows do not share one column set, so a row has no repeatable identity`,
    ),
    verdict(
      'C5',
      !siblings.has(normalized),
      () => `"${candidate.name}" collides with an existing table named "${normalized}"`,
    ),
  ];

  const failed = conditions.filter((c) => !c.ok).map((c) => c.id);
  return {
    ok: failed.length === 0,
    name: candidate.name,
    conditions,
    failed,
    reason: conditions
      .filter((c) => !c.ok)
      .map((c) => `${c.id} (${c.name}): ${c.reason ?? ''}`)
      .join('; '),
    exempt: false,
  };
}

function verdict(
  id: StarSchemaConditionId,
  ok: boolean,
  reason: () => string,
): StarSchemaCondition {
  return ok
    ? { id, name: CONDITION_NAMES[id], ok: true }
    : { id, name: CONDITION_NAMES[id], ok: false, reason: reason() };
}

export interface AdmitOptions extends ContractOptions {
  /**
   * Tables already registered in the workspace. A candidate that maps onto one
   * of these is EXEMPT: a workspace seeded by an older release can hold a
   * `table_1`, and re-importing into it must keep working rather than being
   * refused by a gate written later.
   */
  registered?: Iterable<string>;
}

/** The contract check, with the already-in-the-model exemption applied. */
export function admitModelTable(
  candidate: ModelTableCandidate,
  opts: AdmitOptions = {},
): StarSchemaContractResult {
  const registered = new Set<string>();
  for (const t of opts.registered ?? []) registered.add(normalizeName(t));
  if (registered.has(normalizeName(candidate.name))) {
    return {
      ok: true,
      name: candidate.name,
      conditions: [],
      failed: [],
      reason: '',
      exempt: true,
    };
  }
  return checkStarSchemaContract(candidate, opts);
}

export interface PlanAdmissionOptions extends AdmitOptions {
  /**
   * Which conditions are REFUSALS. Anything outside this set is still evaluated
   * and reported — it just does not remove the table from the plan. Defaults to
   * all five.
   */
  enforce?: StarSchemaConditionId[];
}

export interface PlanAdmission {
  admitted: ModelTableCandidate[];
  /** Results for candidates removed from the plan (an enforced condition failed). */
  rejected: StarSchemaContractResult[];
  /** Every failing result, enforced or not — nothing fails invisibly. */
  reported: StarSchemaContractResult[];
  /** One user-readable line per failing result, in `reported` order. */
  notices: string[];
}

/**
 * Run the contract across a whole plan. C5 is evaluated against the other
 * candidates as well as the workspace, so a fan-out where two fragments resolve
 * to the same name is caught: the first keeps the name, the second is refused.
 */
export function admitPlan(
  candidates: ModelTableCandidate[],
  opts: PlanAdmissionOptions = {},
): PlanAdmission {
  const enforce = new Set<StarSchemaConditionId>(opts.enforce ?? ['C1', 'C2', 'C3', 'C4', 'C5']);
  const registered = new Set<string>();
  for (const t of opts.registered ?? []) registered.add(normalizeName(t));
  // C5 siblings: everything already in the workspace, plus the names claimed by
  // earlier candidates in this same plan.
  const claimed = new Set<string>(registered);
  for (const s of opts.siblingNames ?? []) claimed.add(normalizeName(s));
  const admitted: ModelTableCandidate[] = [];
  const rejected: StarSchemaContractResult[] = [];
  const reported: StarSchemaContractResult[] = [];
  const notices: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate.name);
    // A candidate that maps onto a registered table is an append into it, not a
    // collision with it — so the registered name is withheld from its sibling set.
    const siblings = new Set(claimed);
    if (registered.has(normalized)) siblings.delete(normalized);
    const result = admitModelTable(candidate, { ...opts, registered, siblingNames: siblings });
    claimed.add(normalized);
    if (result.ok) {
      admitted.push(candidate);
      continue;
    }
    reported.push(result);
    if (result.failed.some((id) => enforce.has(id))) {
      rejected.push(result);
      notices.push(`Skipped "${result.name}": ${result.reason}`);
      continue;
    }
    // Not a refusal here, but never invisible: the caller still gets a line it
    // can show, so an odd-shaped table that WAS imported is explainable.
    admitted.push(candidate);
    notices.push(`Imported "${result.name}" despite ${result.reason}`);
  }

  return { admitted, rejected, reported, notices };
}
