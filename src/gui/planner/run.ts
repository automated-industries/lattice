import type { Relation } from '../../types.js';
import { isInternalNativeEntity } from '../../framework/native-entities.js';
import type { ActiveDb } from '../active-db.js';
import { getGuiEntities, isJunctionTable, type GuiTableSummary } from '../data.js';
import {
  createUserRelation,
  createUserEntity,
  aiDeleteEntity,
  setTableDefinition,
} from '../schema-ops.js';
import { findTableDuplicates, mergeDuplicates, type DedupServiceCtx } from '../dedup-service.js';
import { detect } from './detect.js';
import { buildModelProfile, type IntrospectDb, type StructuralInput } from './introspect.js';
import { runAutoTier, type ApplyDeps } from './apply.js';
import { applyRenameTable, applyExtractDimension, applyRetypeColumn } from './appliers.js';
import { syncDismissed, loadDismissed } from './plan-state.js';
import type {
  DataModelPlan,
  ModelProfile,
  PlanOp,
  NormalizedRelation,
  TableTier,
} from './types.js';

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
  return (
    name.startsWith('_lattice') || name.startsWith('__lattice') || isInternalNativeEntity(name)
  );
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

/** Resolve each GUI table into the structural input the introspect shell consumes.
 *  Takes only the read-only slice ({@link PlannerWorkspace}) so a caller that has
 *  no full workspace handle can still profile the model. */
export function buildStructurals(active: PlannerWorkspace): StructuralInput[] {
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
function introspectDb(active: PlannerWorkspace): IntrospectDb {
  const db = active.db;
  return {
    getRegisteredTableNames: () => db.getRegisteredTableNames(),
    getRegisteredColumns: (t) => db.getRegisteredColumns(t),
    getRegisteredFieldTypes: (t) => db.getRegisteredFieldTypes(t),
    getPrimaryKey: (t) => db.getPrimaryKey(t),
    isComputedTable: (n) => db.isComputedTable(n),
    getConnectedSource: (t) => db.getConnectedSource(t),
    connectedTables: () => db.connectedTables(),
    // The introspect opts are a structural subset of latticesql's QueryOptions
    // (its `filters` op is a wider string here); the cast hands them straight to
    // the real bounded reader, which validates the op.
    query: (t, o) => db.query(t, o as Parameters<typeof db.query>[1]),
    boundedCount: (t, o) => db.boundedCount(t, o),
  };
}

/**
 * Wire the plan appliers to the real AUDITED primitives. Every op the review
 * surface can show is now something it can actually run — a plan the user can
 * SEE but not APPLY is worse than no plan.
 *
 * The AUTO tier only ever uses `addRelationship` — a config-only belongsTo
 * relation over the EXISTING FK column (`createUserRelation`), which represents
 * the 1:many FK the planner detected (not an empty m2m junction) and is
 * reversible via the `schema.add_relation` op. The PROPOSE-tier appliers each
 * route to their proven primitive: `dedupRows` → `findTableDuplicates` +
 * `mergeDuplicates` (soft-deletes duplicates, re-points links onto the survivor,
 * recoverable from Trash / Undo); `mergeTables` → `aiDeleteEntity({move_to})`
 * (copies rows into the target then removes the source, rewiring links);
 * `renameTable` / `extractDimension` / `retypeColumn` → the restructure
 * appliers, which compose the same audited create-entity / create-row /
 * add-column / update-row / add-relation / rename primitives (see
 * `./appliers.ts`).
 */
export function applyDepsFor(active: ActiveDb, sessionId: string): ApplyDeps {
  return {
    addRelationship: async (child, column, parent) => {
      const r = await createUserRelation(active, child, column, parent, sessionId);
      return r ? { relationName: r.relationName } : null;
    },
    documentTable: async (table, description) => {
      // Write BOTH stores. The detector decides whether a table still needs
      // documenting by reading the config, while this used to write only the
      // metadata row — so the read and the write disagreed and the rule
      // re-proposed the same table forever, no matter how many times it was
      // applied.
      await setTableDefinition(active, table, description);
    },
    mergeTables: async (source, target) => {
      const outcome = await aiDeleteEntity(active, source, { move_to: target }, sessionId);
      // move_to is always supplied, so `needsResolution` is unreachable — but
      // surface it loudly rather than silently reporting success.
      if ('needsResolution' in outcome) return { ok: false, error: outcome.message };
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    },
    dedupRows: async (table) => {
      const dedupCtx: DedupServiceCtx = {
        db: active.db,
        feed: active.feed,
        softDeletable: active.softDeletable,
        configPath: active.configPath,
        outputDir: active.outputDir,
        ...(sessionId ? { sessionId } : {}),
      };
      try {
        const groups = await findTableDuplicates(dedupCtx, table);
        for (const g of groups) {
          const [survivor, ...sources] = g.ids;
          if (survivor && sources.length > 0) {
            await mergeDuplicates(dedupCtx, table, survivor, sources);
          }
        }
        return { ok: true };
      } catch (e) {
        // The scan-cap refusal and any mutation error surface loudly — the
        // Apply button reports the message instead of a silent no-op.
        return { ok: false, error: (e as Error).message };
      }
    },
    renameTable: (from, to) => applyRenameTable(active, from, to, sessionId),
    extractDimension: (table, column, dimTable) =>
      applyExtractDimension(active, table, column, dimTable, sessionId, (name, columns) =>
        createUserEntity(active, name, columns, sessionId, { rejectAnonymous: true }),
      ),
    retypeColumn: (table, column, toType) =>
      applyRetypeColumn(active, table, column, toType, sessionId),
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

/**
 * Above this many modellable tables the planner skips its (O(tables²), synchronous)
 * detection pass rather than block the single request loop — an over-imported workspace
 * would otherwise peg a core and time out every endpoint. Auto-tidy is best-effort; a
 * workspace this large is past the point where auto-normalization helps anyway.
 */
export const MAX_PLANNER_TABLES = 150;

export interface EnsurePlanOptions {
  sessionId: string;
  /**
   * Dismissed proposal fingerprints (never re-surfaced). Reconciled with the
   * workspace's durable plan-state table on every pass — stored fingerprints
   * are hydrated into this set, and set members not yet stored are written — so
   * a caller that only tracks dismissals in memory still gets state that
   * survives a restart. Mutated in place.
   */
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
export async function ensurePlan(
  active: ActiveDb,
  opts: EnsurePlanOptions,
): Promise<DataModelPlan> {
  const before = shapeToken(introspectDb(active));
  const cached = planCache.get(active.configPath);
  if (!opts.force && cached?.token === before) return cached.plan;

  // Let the workspace's own background schema convergence finish first. It
  // registers the framework's bookkeeping tables, and on a single-writer engine
  // its DDL and ours cannot be in flight at the same time. Convergence never
  // rejects, and the plan should describe the converged schema anyway.
  await active.converged;
  // Reconcile the caller's dismissal set with the durable plan-state table
  // BEFORE detection, so a proposal the user waved off on a previous run is
  // filtered out of this one too.
  const dismissed = await syncDismissed(active.db, opts.dismissed ?? new Set<string>());

  const structurals = buildStructurals(active);
  // Scale guard: the relationship/merge detection below (detect) is an O(tables^2)
  // SYNCHRONOUS pass, and buildModelProfile's reads only cross microtask boundaries, so on
  // a very large workspace (e.g. an accidental over-import of hundreds of tables) this pegs
  // a CPU core on the single request loop and starves every other endpoint. Above the cap,
  // skip the tidy pass entirely (a no-op plan) so the app stays responsive. Auto-tidy is
  // best-effort; normal-size workspaces are unaffected.
  if (structurals.length > MAX_PLANNER_TABLES) {
    const skipped: DataModelPlan = { autoApplied: [], proposals: [], profileHash: before };
    planCache.set(active.configPath, { token: before, plan: skipped });
    return skipped;
  }
  const profile = await buildModelProfile(introspectDb(active), structurals);
  const ops = detect(profile);
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

/**
 * The narrow, READ-ONLY slice of a workspace the profiler needs. An `ActiveDb`
 * satisfies it structurally; so does the assistant's dispatch context, which is
 * how a chat turn can ask what the planner would propose without the chat layer
 * having to carry a whole workspace handle.
 */
export interface PlannerWorkspace {
  db: ActiveDb['db'];
  configPath: string;
  outputDir: string;
  computedTables: Set<string>;
}

/** A proposal plus the size of the object it would touch. */
export interface PlanPreviewItem {
  op: PlanOp;
  /** Bounded live-row count of the proposal's target table. */
  rows: number;
  /** True when the count hit the bounded-read cap (so `rows` is a lower bound). */
  rowsCapped: boolean;
}

export interface PlanPreview {
  proposals: PlanPreviewItem[];
  /** Tables the profiler intentionally skipped, with why. */
  skipped: ModelProfile['skipped'];
}

/**
 * What the planner WOULD propose, without applying anything.
 *
 * Deliberately separate from {@link ensurePlan}: that one applies the AUTO tier
 * and owns the watermark cache, and a read-only caller must neither mutate the
 * workspace nor poison that cache with an auto-tier-less plan (which would make
 * a later pass skip the auto fixes entirely). So this runs its own detection
 * pass, writes nothing, and caches nothing. Bounded by the same table cap as
 * the full pass.
 */
export async function previewPlan(
  ws: PlannerWorkspace,
  opts: { dismissed?: Set<string> } = {},
): Promise<PlanPreview> {
  const structurals = buildStructurals(ws);
  if (structurals.length > MAX_PLANNER_TABLES) return { proposals: [], skipped: [] };
  const profile = await buildModelProfile(introspectDb(ws), structurals);
  const dismissed = opts.dismissed ?? new Set(await loadDismissed(ws.db));
  const sizeOf = new Map(profile.tables.map((t) => [t.name, t]));
  const proposals: PlanPreviewItem[] = [];
  for (const op of detect(profile)) {
    if (op.tier !== 'propose' || dismissed.has(op.id)) continue;
    const t = sizeOf.get(op.target.table);
    proposals.push({ op, rows: t?.rowCount ?? 0, rowsCapped: t?.rowCountCapped ?? false });
  }
  return { proposals, skipped: profile.skipped };
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
