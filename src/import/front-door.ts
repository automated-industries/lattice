import {
  admitPlan,
  type ModelTableCandidate,
  type PlanAdmission,
  type StarSchemaConditionId,
} from '../gui/model-contract.js';
import {
  resolveImportNames,
  type NameAssist,
  type ResolvedImportNames,
} from '../gui/import-naming.js';
import { dedupeAndDetectViews } from './dedupe-views.js';
import { inferSchema } from './infer.js';
import {
  matchSchemaToExisting,
  renameEntities,
  type ExistingTable,
  type SchemaMatch,
} from './match.js';
import { MAX_IMPORT_TABLES, renameSourceKeys } from './name-policy.js';
import type { PlanSource, PlanSourceKind } from './plan-source.js';
import type { DetectedView, ProposedSchema } from './types.js';

/**
 * THE import front door.
 *
 * Every path that turns parsed records into a proposed model comes through
 * here: the passive file drop, the explicit "import this" request, and anything
 * added later. Before this existed each door assembled the same steps for
 * itself, so a rule added to one door — name resolution, a shape refusal — was
 * simply absent from the others, and which rules applied depended on which
 * caller happened to run. Consolidating the sequence is what makes the naming
 * ladder and the shape contract impossible to bypass.
 *
 * The order matters and is fixed here:
 *   1. resolve names on the SOURCE KEYS, before inference ever sees them, so no
 *      positional name can reach a table definition;
 *   2. infer the schema and detect reconstructable views;
 *   3. run the star-schema contract over the proposed tables;
 *   4. match against what the workspace already has, and rename into it.
 *
 * Nothing here writes: the result is a plan plus a report. Materializing stays
 * with the caller, which is what lets one door propose and another commit.
 */

export interface BuildImportPlanInput {
  /** The parsed source: top-level keys mapping to record arrays. */
  data: Record<string, unknown>;
  source: PlanSource;
  /** Importable data tables already in the workspace, for snapshot matching. */
  existing?: ExistingTable[];
  /** Every registered table name — exempt from the contract gate. */
  registered?: Iterable<string>;
  minLinkConfidence?: number;
  /** Bounded name assist. Absent/null ⇒ deterministic naming only. */
  nameAssist?: NameAssist | null;
  maxAssistCalls?: number;
  /** Documents this ingest kept as plain files instead of extracting. */
  documentsKeptAsFiles?: number;
  /** False when no model provider is configured to extract documents. */
  extractionAvailable?: boolean;
  /** Table ceiling for the whole import. Defaults to the shared import cap. */
  maxTables?: number;
  /** Conditions that REFUSE a table. Defaults to {@link enforcedConditionsFor}. */
  enforce?: StarSchemaConditionId[];
}

export interface ImportPlanReport {
  /** The source with its keys renamed — materialize MUST read records from this. */
  data: Record<string, unknown>;
  /** Gate-filtered plan under its inferred names (what a proposal displays). */
  plan: ProposedSchema;
  views: DetectedView[];
  schemaMatch: SchemaMatch;
  /** The same plan renamed into the matched existing tables — ready to materialize. */
  matched: { plan: ProposedSchema; views: DetectedView[] };
  naming: ResolvedImportNames;
  admission: PlanAdmission;
  /** Names the gate removed from the plan. */
  dropped: string[];
  /** Tables this import would create or write (entities + dimensions + junctions). */
  tableCount: number;
  /** True when `tableCount` exceeds the cap — the caller decides what to do about it. */
  overCap: boolean;
  /** User-readable outcome lines. Empty when the import was clean. */
  notices: string[];
}

/**
 * Which contract conditions refuse a table, by origin.
 *
 * A document's embedded tables are frequently layout — an agenda, a signature
 * block — so shape is load-bearing there, and the floors match the bar a
 * document already had to clear to be imported at all. Spreadsheets, delimited
 * files and JSON are data by construction: a narrow or short table is a real
 * table, so shape is REPORTED for them but never a refusal. Naming (C1) and
 * distinctness (C5) are absolute — a table nobody can name or tell apart from
 * another is not importable from any origin.
 */
export function enforcedConditionsFor(kind: PlanSourceKind): StarSchemaConditionId[] {
  return kind === 'document' ? ['C1', 'C2', 'C3', 'C5'] : ['C1', 'C5'];
}

/** The line shown when documents were kept as files for want of a model. */
export function documentsKeptAsFilesNotice(count: number): string {
  return count === 1
    ? 'Kept 1 document as a file - connect a model to extract it'
    : `Kept ${String(count)} documents as files - connect a model to extract them`;
}

/** Column headers for a source key, for the name assist's benefit. */
function columnsOf(data: Record<string, unknown>, key: string): string[] {
  const cols = data[key + 'Cols'];
  if (Array.isArray(cols)) return cols.filter((c): c is string => typeof c === 'string');
  const rows = data[key];
  if (!Array.isArray(rows)) return [];
  const first: unknown = rows[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return Object.keys(first as Record<string, unknown>);
  }
  return [];
}

/**
 * The width a table PRESENTS to the user, which is not the width the inferrer
 * leaves on the entity: inference strips categorical columns out into dimensions
 * and reference columns out into linkages. Counting only what survives would
 * make a perfectly ordinary table look one column wide and refuse it.
 */
function presentedColumns(plan: ProposedSchema, entityName: string): string[] {
  const out = new Set<string>();
  const entity = plan.entities.find((e) => e.name === entityName);
  for (const c of entity?.columns ?? []) out.add(c.name);
  for (const d of plan.dimensions) {
    if (d.fromEntities.includes(entityName)) out.add(d.sourceField);
  }
  for (const l of plan.linkages) {
    if (l.fromEntity === entityName) out.add(l.fromField);
  }
  return [...out];
}

/** Remove dropped entities from a plan, along with everything that referenced them. */
function withoutEntities(
  plan: ProposedSchema,
  views: DetectedView[],
  keep: Set<string>,
): { plan: ProposedSchema; views: DetectedView[] } {
  const dimensions = plan.dimensions
    .map((d) => ({ ...d, fromEntities: d.fromEntities.filter((n) => keep.has(n)) }))
    .filter((d) => d.fromEntities.length > 0);
  const dimNames = new Set(dimensions.map((d) => d.name));
  const reachable = (name: string): boolean => keep.has(name) || dimNames.has(name);
  const keepLink = (l: { fromEntity: string; toEntity: string }): boolean =>
    keep.has(l.fromEntity) && reachable(l.toEntity);
  return {
    plan: {
      ...plan,
      entities: plan.entities.filter((e) => keep.has(e.name)),
      dimensions,
      linkages: plan.linkages.filter(keepLink),
      marginalLinks: plan.marginalLinks.filter(keepLink),
    },
    // A view is a projection of its master; without the master there is nothing
    // to project from.
    views: views.filter((v) => keep.has(v.master)),
  };
}

export async function buildImportPlan(input: BuildImportPlanInput): Promise<ImportPlanReport> {
  const notices: string[] = [];
  const maxTables = input.maxTables ?? MAX_IMPORT_TABLES;
  const registered = [...(input.registered ?? [])];

  // ── 1. Name the source keys, before inference sees them ──
  const recordKeys = Object.keys(input.data).filter((k) => Array.isArray(input.data[k]));
  const naming = await resolveImportNames(
    recordKeys.map((key) => ({ key, columns: columnsOf(input.data, key) })),
    {
      sourceName: input.source.originalName,
      taken: registered,
      ...(input.nameAssist ? { assist: input.nameAssist } : {}),
      ...(input.maxAssistCalls !== undefined ? { maxAssistCalls: input.maxAssistCalls } : {}),
    },
  );
  const renames = new Map<string, string>();
  for (const [key, name] of Object.entries(naming.names)) {
    if (name !== key) renames.set(key, name);
  }
  const data = renameSourceKeys(input.data, renames);
  notices.push(...naming.assistNotes);
  if (naming.assistUnavailable) {
    const positional = [...renames.keys()];
    notices.push(
      `Named ${String(positional.length)} tables positionally from "${input.source.originalName}" ` +
        `(${positional.map((k) => naming.names[k] ?? k).join(', ')}) - ` +
        `connect a model to name them from their contents`,
    );
  }

  // ── 2. Infer ──
  // minLinkConfidence is passed through only when the caller set one, so an
  // omitted value keeps the inferrer's own default rather than being pinned to 0.
  const inferred = await dedupeAndDetectViews(
    await inferSchema(
      data,
      input.minLinkConfidence !== undefined ? { minLinkConfidence: input.minLinkConfidence } : {},
    ),
    data,
  );

  // ── 3. Gate ──
  const candidates: ModelTableCandidate[] = inferred.plan.entities.map((e) => ({
    name: e.name,
    columns: presentedColumns(inferred.plan, e.name),
    rowCount: e.rowCount,
    naturalKey: e.naturalKey,
  }));
  const admission = admitPlan(candidates, {
    registered,
    enforce: input.enforce ?? enforcedConditionsFor(input.source.kind),
  });
  notices.push(...admission.notices);
  const dropped = admission.rejected.map((r) => r.name);
  const keep = new Set(admission.admitted.map((c) => c.name));
  const gated =
    dropped.length > 0
      ? withoutEntities(inferred.plan, inferred.views, keep)
      : { plan: inferred.plan, views: inferred.views };

  // ── 4. Match into the workspace ──
  const schemaMatch = matchSchemaToExisting(input.existing ?? [], gated.plan);
  const matched = renameEntities(gated.plan, gated.views, schemaMatch.rename);

  const tableCount =
    gated.plan.entities.length +
    gated.plan.dimensions.length +
    new Set(gated.plan.linkages.map((l) => l.junction).filter(Boolean)).size;
  const overCap = tableCount > maxTables;
  if (overCap) {
    notices.push(
      `This import would create ${String(tableCount)} tables, over the safe limit of ${String(maxTables)}.`,
    );
  }

  // Documents that stopped at "kept as a file" because nothing could read them.
  const kept = input.documentsKeptAsFiles ?? 0;
  if (kept > 0 && input.extractionAvailable === false) {
    notices.push(documentsKeptAsFilesNotice(kept));
  }

  return {
    data,
    plan: gated.plan,
    views: gated.views,
    schemaMatch,
    matched,
    naming,
    admission,
    dropped,
    tableCount,
    overCap,
    notices,
  };
}
