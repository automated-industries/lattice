import type { Lattice } from '../../lattice.js';
import type { TableDefinition } from '../../types.js';
import { NOOP_RENDER } from '../../render/engine.js';

/**
 * Durable planner state — currently the set of proposals the user waved off.
 *
 * A dismissal used to live only in a per-process `Set`, so the same "fix" came
 * straight back on the next launch. It is workspace state, not session state:
 * the user's answer to "should this table be merged?" is about the DATA, so it
 * belongs with the data.
 *
 * The table follows the framework's bookkeeping-table pattern (see the native
 * entity registry): a `__lattice_`-prefixed name so it never surfaces in the
 * GUI's object cards, nav, allowlist or the planner's own profiler; a
 * {@link NOOP_RENDER} spec so it writes no markdown; registered with
 * `defineLate` on first use so an existing workspace picks it up without a
 * migration or a reopen; and stored IN the database so the state travels with
 * the database (correct for cloud + multi-machine), exactly like
 * `__lattice_migrations` and `__lattice_native_entities`.
 */

/** Bookkeeping table holding one row per dismissed proposal fingerprint. */
export const PLAN_STATE_TABLE = '__lattice_plan_state';

const PLAN_STATE_DEF: TableDefinition = {
  columns: {
    /** The `PlanOp.id` fingerprint (kind + normalized operands) — the dismiss key. */
    op_id: 'TEXT PRIMARY KEY',
    /** The `PlanOpKind` at dismiss time, for later "what do people wave off?" analysis. */
    kind: 'TEXT',
    dismissed_at: 'TEXT',
  },
  primaryKey: 'op_id',
  render: NOOP_RENDER,
  outputFile: '.lattice-native/plan-state.md',
};

/**
 * True when this connection may create the bookkeeping table. A scoped cloud
 * member connects as a role with no DDL privilege, and its dismiss route is
 * owner-gated anyway, so there is nothing for it to persist — a member's plan
 * view stays read-only and process-local. This is a deliberate skip for a
 * caller that structurally cannot write, NOT a swallowed failure: for every
 * other caller a failure propagates.
 */
function canPersist(db: Lattice): boolean {
  return !db.isCloudMemberOpen();
}

/**
 * Register the plan-state table on the live DB if it isn't already.
 *
 * Returns false when the table cannot be registered YET. A late definition is
 * only legal once the database has finished initializing, and the planner can
 * run against a workspace that is still coming up (the debounced trigger fires
 * off the same open). That is a not-ready condition, not a failure: dismissals
 * simply are not persisted on that pass, and the next pass reconciles in both
 * directions and picks them up. Letting it throw instead aborted the WHOLE
 * planner pass, so a workspace got no plan at all.
 *
 * Narrow on purpose — every other failure propagates.
 */
async function ensureTable(db: Lattice): Promise<boolean> {
  if (!canPersist(db)) return false;
  if (db.getRegisteredTableNames().includes(PLAN_STATE_TABLE)) return true;
  try {
    await db.defineLate(PLAN_STATE_TABLE, PLAN_STATE_DEF);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('must be called after init')) return false;
    throw e;
  }
  return true;
}

/** Every dismissed proposal fingerprint stored for this workspace. */
export async function loadDismissed(db: Lattice): Promise<string[]> {
  if (!(await ensureTable(db))) return [];
  const rows = (await db.query(PLAN_STATE_TABLE, {})) as { op_id?: unknown }[];
  return rows.map((r) => String(r.op_id)).filter((id) => id !== 'undefined');
}

/**
 * Durably dismiss one proposal. Idempotent — dismissing the same fingerprint
 * twice is a no-op, not an error (the id is the primary key).
 */
export async function recordDismissal(db: Lattice, opId: string, kind?: string): Promise<void> {
  if (!(await ensureTable(db))) return;
  await db.upsert(PLAN_STATE_TABLE, {
    op_id: opId,
    kind: kind ?? '',
    dismissed_at: new Date().toISOString(),
  });
}

/**
 * Reconcile a caller-held dismissal set with the durable table, in BOTH
 * directions: stored fingerprints are hydrated into the set (so a restart keeps
 * its answers) and set members not yet stored are written (so a caller that
 * only tracks dismissals in memory — the plan review route — gets durability
 * without having to know about this table).
 *
 * Returns the same set instance, mutated in place, so the caller's cached
 * reference stays authoritative.
 */
export async function syncDismissed(db: Lattice, held: Set<string>): Promise<Set<string>> {
  if (!(await ensureTable(db))) return held;
  const stored = new Set(await loadDismissed(db));
  for (const id of stored) held.add(id);
  for (const id of held) {
    if (!stored.has(id)) await recordDismissal(db, id);
  }
  return held;
}
