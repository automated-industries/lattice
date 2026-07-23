import { readFileSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { excelFormulaSummary, excelImportWarnings, excelToRecords } from '../import/excel.js';
import { csvToRecords } from '../import/csv.js';
import { docxToRecords, pptxToRecords } from './ai/doc/doc-tables.js';
import {
  buildComputedProposals,
  type ComputedTableProposal,
} from '../import/computed-proposals.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import { materializeImport } from '../import/materialize.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { getClarifyThreshold } from './assistant-routes.js';
import { detectImportAsOf } from './import-detect.js';
import { detectAsOfColumns } from '../import/asof-columns.js';

/**
 * Automatic structured import for a file dropped into the assistant. The importer
 * is reachable ONLY through this single chat-upload door. Behavior:
 *
 *   - not parseable as structured data → null (kept as a plain reference file)
 *   - no entities inferred             → null
 *   - matches an existing dataset + a CONFIDENT date → silent import as a dated
 *     snapshot (`imported:true`), no preview, no Q&A
 *   - matches an existing dataset but NO/ambiguous date → `reason:'needs-confirm'`
 *     + a full proposal (surface the date choice, don't guess)
 *   - brand-new structured data (no match) → `reason:'new-dataset'` + a full
 *     proposal; tables are created only when the user confirms (never silently
 *     from a chat drop)
 *
 * Non-silent cases carry the proposal the inline confirm card renders; the apply
 * route (`/api/import/apply`) re-reads the file's bytes from its `fileId` and
 * re-derives everything, so these fields are display-only.
 */

export interface AutoImportResult {
  imported: boolean;
  /** When `imported` is false: why, and which inline card to show. */
  reason?: 'needs-confirm' | 'new-dataset';
  asOf: string | null;
  matchedCount: number;
  totalEntities: number;
  tables: string[];
  rows: number;
  // ── Proposal payload for the inline confirm card (present when `reason` is set).
  /** The dropped file's `files` row id — the apply route resolves it to the blob. */
  fileId?: string;
  plan?: ReturnType<typeof dedupeAndDetectViews>['plan'];
  views?: ReturnType<typeof dedupeAndDetectViews>['views'];
  asOfCandidates?: Awaited<ReturnType<typeof detectImportAsOf>>;
  asOfColumns?: ReturnType<typeof detectAsOfColumns>;
  schemaMatch?: ReturnType<typeof matchSchemaToExisting>;
  /**
   * The clarify threshold link inference ran under. The card echoes it back on
   * apply so both sides band marginal links identically even if the preference
   * changes between upload and confirm.
   */
  linkConfidence?: number;
  /** Opt-in computed-table proposals (new-dataset flows only; display-only —
   *  the apply route re-derives them and intersects with the user's picks). */
  computedProposals?: ComputedTableProposal[];
  /** Reconciliation warnings from the read (a stacked-table sheet where only the largest
   *  table was imported) — surfaced on the confirm card so a partial import is never silent. */
  importWarnings?: string[];
  /** Scale guard: true when a brand-new import looks pathological (too many tables, a
   *  mostly-empty/template set, a document fan-out, or partial-import warnings). The client
   *  then surfaces the confirm card instead of silently materializing — "silent by default,
   *  interrupt on genuine low confidence." */
  lowConfidence?: boolean;
  /** Human-readable reason the scale guard tripped (shown on the card). */
  guardReason?: string;
}

function existingDataTables(db: Lattice): ExistingTable[] {
  const native = new Set<string>(NATIVE_ENTITY_NAMES);
  const out: ExistingTable[] = [];
  for (const t of db.getRegisteredTableNames()) {
    if (native.has(t)) continue;
    // Never offer a connected external mirror or a computed view as an import DESTINATION: both
    // are read-only (a connected table syncs from its source; a computed view is derived), so an
    // import that matched + wrote into one would either be overwritten on the next sync or corrupt
    // a projection. This keeps the importer's "matches an existing dataset → append" path off them.
    if (db.getConnectedSource(t) || db.isComputedTable(t)) continue;
    const columns = Object.keys(db.getRegisteredColumns(t) ?? {});
    if (columns.length > 0) out.push({ name: t, columns });
  }
  return out;
}

async function readStructured(abs: string, name: string): Promise<Record<string, unknown>> {
  // Key the parser on the ORIGINAL name's extension, not `abs`: an uploaded file
  // is staged to an extensionless temp path, so testing `abs` would misroute an
  // `.xlsx` into the JSON branch. The bytes are read from `abs` either way.
  if (/\.xlsx?$/i.test(name)) return excelToRecords(abs);
  if (/\.(csv|tsv)$/i.test(name)) return csvToRecords(abs, name);
  // Documents: extract embedded tables (every row) so a .docx/.pptx of tabular data
  // flows through the same deterministic importer as a spreadsheet instead of falling
  // to the model. A doc with no tables → {} → autoImportStructured infers no entities
  // and returns null (kept as a reference file + text-ingested for its prose).
  if (/\.docx$/i.test(name)) return docxToRecords(abs);
  if (/\.pptx$/i.test(name)) return pptxToRecords(abs);
  return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
}

/** True when a parsed document's extracted tables include at least one SUBSTANTIVE table
 *  (>=2 columns AND >=2 data rows) — a real dataset, not an incidental layout table. */
function hasSubstantiveDocTable(data: Record<string, unknown>): boolean {
  for (const recs of Object.values(data)) {
    if (Array.isArray(recs) && recs.length >= 2) {
      const first: unknown = recs[0];
      if (first && typeof first === 'object' && Object.keys(first).length >= 2) {
        return true;
      }
    }
  }
  return false;
}

/** Above this many tables a brand-new import is treated as low-confidence. */
const MAX_SILENT_TABLES = 12;

/**
 * Scale guard for a brand-new import: trips when the proposal looks pathological — too many
 * tables, a mostly empty/template set, a document fan-out of auto-named tables, or a partial
 * import — so the client surfaces the confirm card (a preview/decline surface) instead of
 * silently materializing dozens/hundreds of tables. Small, clean imports do not trip.
 */
function importScaleGuard(
  plan: {
    entities: { name: string; rowCount?: number; columns?: unknown[] }[];
    dimensions: unknown[];
  },
  importWarnings: string[],
): { trip: boolean; reason: string } {
  const tableCount = plan.entities.length + plan.dimensions.length;
  if (tableCount >= MAX_SILENT_TABLES) {
    return { trip: true, reason: `${String(tableCount)} tables — review before importing` };
  }
  const thin = plan.entities.filter(
    (e) => (e.rowCount ?? 0) <= 1 || (e.columns?.length ?? 0) <= 1,
  ).length;
  if (plan.entities.length >= 2 && thin > plan.entities.length / 2) {
    return { trip: true, reason: 'mostly empty or template tables — review before importing' };
  }
  const fanout = plan.entities.filter((e) => /^table_\d+$/i.test(e.name)).length;
  if (fanout >= 8) {
    return {
      trip: true,
      reason: 'many auto-named tables from a document — review before importing',
    };
  }
  if (importWarnings.length > 0) {
    return { trip: true, reason: 'a partial or ambiguous import — review before importing' };
  }
  return { trip: false, reason: '' };
}

export async function autoImportStructured(
  db: Lattice,
  configPath: string | null,
  abs: string,
  name: string,
): Promise<AutoImportResult | null> {
  if (!/\.(xlsx?|csv|tsv|json|docx|pptx)$/i.test(name)) return null;
  let data: Record<string, unknown>;
  try {
    data = await readStructured(abs, name);
  } catch {
    return null; // not structured data we can model — leave it as a reference file
  }
  // Documents: only propose a structured import when the extracted tables are SUBSTANTIVE
  // (>=2 columns AND >=2 rows) — a real dataset, not an incidental layout/instructions table.
  // Otherwise keep the doc as a plain reference file rather than erroring or over-importing.
  if (/\.(docx|pptx)$/i.test(name) && !hasSubstantiveDocTable(data)) return null;
  // The user's clarify threshold decides which inferred links are created vs
  // asked about; carried on the proposal so apply uses the same bar.
  const linkConfidence = getClarifyThreshold();
  const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
    inferSchema(data, { minLinkConfidence: linkConfidence }),
    data,
  );
  if (inferredPlan.entities.length === 0) return null;

  const existing = existingDataTables(db);
  const schemaMatch = matchSchemaToExisting(existing, inferredPlan);
  const asOfCandidates = await detectImportAsOf(db, data, { abs, fileName: name });
  const asOf = asOfCandidates[0]?.date ?? null;
  const asOfColumns = detectAsOfColumns(data, inferredPlan);
  // Reconciliation warnings from the Excel read (a stacked-table sheet only partially
  // imported) — surfaced on the confirm card so the user sees a partial import before applying.
  const importWarnings = /\.xlsx?$/i.test(name) ? excelImportWarnings(abs) : [];
  // The proposal the inline confirm card renders (display-only; apply re-derives).
  const proposal = {
    plan: inferredPlan,
    views: inferredViews,
    asOfCandidates,
    asOfColumns,
    schemaMatch,
    matchedCount: schemaMatch.matchedCount,
    totalEntities: schemaMatch.totalEntities,
    tables: [],
    rows: 0,
    linkConfidence,
    ...(importWarnings.length > 0 ? { importWarnings } : {}),
  };

  // Brand-new structured data → a 'new-dataset' proposal. The client imports it SILENTLY
  // (5.1.1) unless the scale guard trips (too many tables / mostly template / doc fan-out /
  // partial import), in which case `lowConfidence` tells the client to surface the confirm
  // card so the user can review + decline instead of silently getting hundreds of tables.
  if (!schemaMatch.isKnownDocument) {
    const computedProposals = buildComputedProposals({
      data,
      plan: inferredPlan,
      rename: schemaMatch.rename,
      // The formula summary was cached by the excelToRecords read above.
      formulaSummary: /\.xlsx?$/i.test(name) ? excelFormulaSummary(abs) : null,
      existingTables: existing.map((t) => t.name),
    });
    const guard = importScaleGuard(inferredPlan, importWarnings);
    return {
      imported: false,
      reason: 'new-dataset',
      asOf,
      ...proposal,
      computedProposals,
      ...(guard.trip ? { lowConfidence: true, guardReason: guard.reason } : {}),
    };
  }
  // Recognized as a known dataset but no confident date — importing undated would
  // overwrite the prior snapshot, so surface a 'needs-confirm' card.
  if (!asOf) {
    return { imported: false, reason: 'needs-confirm', asOf: null, ...proposal };
  }

  // Known document + a confident date → silent import as a dated snapshot.
  const { plan, views } = renameEntities(inferredPlan, inferredViews, schemaMatch.rename);
  const result = await materializeImport({ db, configPath }, data, plan, views, { asOf });
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  return {
    imported: true,
    asOf,
    matchedCount: schemaMatch.matchedCount,
    totalEntities: schemaMatch.totalEntities,
    tables: Object.keys(result.rowsByTable),
    rows,
  };
}

/** The faithful materialization of a parsed structured dataset (all rows). */
export interface FaithfulImportResult {
  /** Tables created/updated by the import. */
  tables: string[];
  /** Total rows materialized across those tables. */
  rows: number;
}

/**
 * Materialize an already-parsed structured dataset into real tables IMMEDIATELY and
 * FAITHFULLY (every row), using the same deterministic pipeline as the confirm-card apply
 * path — infer schema → dedupe/detect views → match to existing tables → materialize.
 * Unlike {@link autoImportStructured} (whose new-dataset path only PROPOSES, never creating
 * tables from a passive drop), this is the executor for an EXPLICIT user request to import
 * a file they attached, so it commits. Returns null when the data has no inferable
 * entities (nothing to import). Every write is auditable + reversible like any other.
 */
export async function importDataFaithfully(
  db: Lattice,
  configPath: string | null,
  data: Record<string, unknown>,
): Promise<FaithfulImportResult | null> {
  const linkConfidence = getClarifyThreshold();
  const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
    inferSchema(data, { minLinkConfidence: linkConfidence }),
    data,
  );
  if (inferredPlan.entities.length === 0) return null;
  const schemaMatch = matchSchemaToExisting(existingDataTables(db), inferredPlan);
  const { plan, views } = renameEntities(inferredPlan, inferredViews, schemaMatch.rename);
  const result = await materializeImport({ db, configPath }, data, plan, views, {});
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  return { tables: Object.keys(result.rowsByTable), rows };
}
