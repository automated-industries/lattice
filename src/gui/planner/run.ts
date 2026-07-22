import type { Relation } from '../../types.js';
import { isInternalNativeEntity } from '../../framework/native-entities.js';
import type { ActiveDb } from '../active-db.js';
import { getGuiEntities, isJunctionTable, type GuiTableSummary } from '../data.js';
import { upsertTableMeta } from '../column-descriptions.js';
import { createUserJunction } from '../schema-ops.js';
import { detect } from './detect.js';
import { buildModelProfile, type IntrospectDb, type StructuralInput } from './introspect.js';
import { runAutoTier, type ApplyDeps } from './apply.js';
import type { DataModelPlan, NormalizedRelation, TableTier } from './types.js';

/**
 * The planner orchestrator: introspect → detect → apply the AUTO tier, returning
 * the plan (auto-applied fixes + pending proposals). This is what the debounced
 * trigger and the `/api/data-model/plan` route both call. It is deterministic and
 * needs NO model provider.
 *
 * A per-workspace watermark (the schema-shape fingerprint) skips the whole pass
 * when nothing structural changed since the last run, so a redundant trigger or
 * an on-open sweep over an unchanged model is a cheap no-op.
 */

/** Tables the planner never reads/reasons about (bookkeeping + assistant storage). */
function isHiddenTable(name: string): boolean {
  return name.startsWith('_lattice') || name.startsWith('__lattice') || isInternalNativeEntity(name);
}

/** Pure tier decision from the resolved provenance flags (unit-tested directly). */
export function deriveTier(flags: {
  computed: boolean;
  junction: boolean;
  connected: boolean;
  hasSourceCol: boolean;
  isFiles: boolean;
}): TableTier {
  if (flags.computed) return 'computed';
  if (flags.junction) return 'junction';
  if (flags.connected || flags.hasSourceCol || flags.isFiles) return 'source';
  return 'lattice';
}

function toNormalizedRelations(relations: Record<string, Relation>): NormalizedRelation[] {
  return Object.entries(relations).map(([name, r]) => ({
    name,
    kind: r.type,
    targetTable: r.table,
    foreignKey: r.foreignKey,
  }));
}

function junctionPairOf(summary: GuiTableSummary): { a: string; b: string } | null {
  const belongsTo = Object.values(summary.relations).filter((r) => r.type === 'belongsTo');
  const a = belongsTo[0]?.table;
  const b = belongsTo[1]?.table;
  return a && b ? { a, b } : null;
}

/** Resolve each GUI table into the structural input the introspect shell consumes. */
export function buildStructurals(active: ActiveDb): StructuralInput[] {
  const gui = getGuiEntities(active.configPath, active.outputDir);
  const connected = new Set(active.db.connectedTables());
  const out: StructuralInput[] = [];
  for (const t of gui.tables) {
    if (isHiddenTable(t.name)) continue;
    const junction = isJunctionTable(t);
    const tier = deriveTier({
      computed: active.db.isComputedTable(t.name) || active.computedTables.has(t.name),
      junction,
      connected: connected.has(t.name) || active.db.getConnectedSource(t.name) !== undefined,
      hasSourceCol: t.columns.includes('_source_connector_id'),
      isFiles: t.name === 'files',
    });
    out.push({
      name: t.name,
      tier,
      relations: toNormalizedRelations(t.relations),
      hasDefinition: typeof t.description === 'string' && t.description.trim() !== '',
      junctionPair: junction ? junctionPairOf(t) : null,
    });
  }
  return out;
}

/** Adapt the Lattice facade to the narrow bounded-read surface introspect needs. */
function introspectDb(active: ActiveDb): IntrospectDb {
  const db = active.db;
  return {
    getRegisteredTableNames: () => db.getRegisteredTableNames(),
    getRegisteredColumns: (t) => db.getRegisteredColumns(t),
    getPrimaryKey: (t) => db.getPrimaryKey(t),
    isComputedTable: (n) => db.isComputedTable(n),
    getConnectedSource: (t) => db.getConnectedSource(t),
    connectedTables: () => db.connectedTables(),
    query: (t, o) => db.query(t, o),
    boundedCount: (t, o) => db.boundedCount(t, o),
  };
}

/**
 * Wire the plan appliers to the real AUDITED primitives. The AUTO tier only ever
 * uses `addRelationship` (a reversible junction, exactly the shipped designer's
 * additive move); the data-rewriting appliers are surfaced for review and are a
 * tracked follow-up (they reuse proven primitives — `mergeDuplicates`,
 * `aiDeleteEntity(move_to)` — but want app-level verification before landing).
 */
export function applyDepsFor(active: ActiveDb, sessionId: string): ApplyDeps {
  const staged = (what: string): Promise<{ ok: boolean; error?: string }> =>
    Promise.resolve({ ok: false, error: `${what} apply is not wired in this build yet` });
  return {
    addRelationship: async (a, b) => {
      const r = await createUserJunction(active, a, b, sessionId);
      return r ? { junction: r.junction } : null;
    },
    documentTable: async (table, description) => {
      await upsertTableMeta(active.db, table, { description });
    },
    mergeTables: () => staged('merge'),
    dedupRows: () => staged('dedup'),
    renameTable: () => staged('rename'),
    extractDimension: () => staged('extract-dimension'),
    retypeColumn: () => staged('retype'),
  };
}

/** Small, stable, non-crypto fingerprint of the schema shape (djb2). */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The schema-shape watermark: sorted `table(col:type,…)` across user tables. A
 *  change to any table/column/type advances it; row-only changes do not (the
 *  event trigger fires post-ingest regardless, so those are still analyzed). */
export function shapeToken(db: IntrospectDb): string {
  const parts: string[] = [];
  for (const name of db.getRegisteredTableNames().sort()) {
    if (isHiddenTable(name)) continue;
    const cols = db.getRegisteredColumns(name);
    if (!cols) continue;
    const colPart = Object.entries(cols)
      .map(([c, ty]) => `${c}:${ty.toLowerCase()}`)
      .sort()
      .join(',');
    parts.push(`${name}(${colPart})`);
  }
  return hashString(parts.join('|'));
}

const planCache = new Map<string, { token: string; plan: DataModelPlan }>();

export interface EnsurePlanOptions {
  sessionId: string;
  /** Dismissed proposal fingerprints (never re-surfaced). */
  dismissed?: Set<string>;
  /** Bypass the watermark cache (e.g. a manual refresh). */
  force?: boolean;
  /**
   * Apply the AUTO tier (default true). Set false for a caller that can only
   * READ the model — a scoped cloud member, whose schema/config writes are
   * owner-gated and would just fail-soft anyway (G9). Detection still runs.
   */
  applyAuto?: boolean;
}

/**
 * Run (or return the cached) plan for a workspace. Applies the AUTO tier and
 * returns pending proposals. Fail-soft is the CALLER's responsibility (the
 * scheduler/sweep wraps this in try/catch; a route lets errors surface) — this
 * function does not swallow.
 */
export async function ensurePlan(active: ActiveDb, opts: EnsurePlanOptions): Promise<DataModelPlan> {
  const before = shapeToken(introspectDb(active));
  const cached = planCache.get(active.configPath);
  if (!opts.force && cached?.token === before) return cached.plan;

  const structurals = buildStructurals(active);
  const profile = await buildModelProfile(introspectDb(active), structurals);
  const ops = detect(profile);
  const dismissed = opts.dismissed ?? new Set<string>();
  const auto = ops.filter((o) => o.tier === 'auto' && !dismissed.has(o.id));
  const proposals = ops.filter((o) => o.tier === 'propose' && !dismissed.has(o.id));
  const autoApplied =
    opts.applyAuto === false ? [] : await runAutoTier(auto, applyDepsFor(active, opts.sessionId));

  // Recompute the token AFTER the AUTO pass so its own structural writes don't
  // read as "changed" and cause an immediate redundant re-plan.
  const plan: DataModelPlan = { autoApplied, proposals, profileHash: before };
  planCache.set(active.configPath, { token: shapeToken(introspectDb(active)), plan });
  return plan;
}

/** Drop a workspace's cached plan (e.g. after a dismiss, or on dispose). */
export function invalidatePlanCache(configPath: string): void {
  planCache.delete(configPath);
}

const PLAN_DEBOUNCE_MS = 4000;
const planTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced, FAIL-SOFT trigger — the deterministic replacement for the LLM
 * designer's schedule hook. Coalesces a whole ingest batch (or a connect + its
 * initial sync) into ONE pass shortly after the last event; the pass is
 * scheduled, never awaited, and wrapped so a failure can NEVER break the
 * ingest/connect it followed. `prepare()` resolves the workspace at fire time
 * (or returns null to skip). Debounced per workspace `key`.
 */
export function scheduleDataModelPlan(
  key: string,
  prepare: () => Promise<{ active: ActiveDb; sessionId: string } | null>,
  debounceMs: number = PLAN_DEBOUNCE_MS,
): void {
  const prev = planTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    planTimers.delete(key);
    void (async () => {
      try {
        const job = await prepare();
        if (!job) return;
        const plan = await ensurePlan(job.active, { sessionId: job.sessionId });
        const applied = plan.autoApplied.filter((a) => a.ok).length;
        if (applied > 0) {
          console.log(`[data-model planner] applied ${String(applied)} structural improvement(s)`);
        }
      } catch (e) {
        // FAIL-SOFT: a best-effort enhancement running AFTER the ingest/connect
        // already succeeded — never surface or rethrow.
        console.warn('[data-model planner] pass failed (non-fatal):', (e as Error).message);
      }
    })();
  }, debounceMs);
  (timer as { unref?: () => void }).unref?.();
  planTimers.set(key, timer);
}
