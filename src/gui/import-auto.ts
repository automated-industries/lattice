import { readFileSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { excelToRecords } from '../import/excel.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import { materializeImport } from '../import/materialize.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { detectImportAsOf } from './import-detect.js';

/**
 * Automatic structured import for a file dropped into the assistant (or any
 * ingest door). When an uploaded `.xlsx`/`.json` is recognized as a NEW PERIOD
 * of a document already in the workspace, it's imported as a dated snapshot into
 * the existing tables — no preview, no Q&A. Deliberately conservative:
 *
 *   - not parseable as structured data → null (kept as a plain reference file)
 *   - no entities inferred           → null
 *   - doesn't match an existing doc  → null (we never silently create a brand-new
 *                                       schema from a chat drop; that's the
 *                                       Import-button's explicit job)
 *   - matches but no date detected   → `{ imported:false, reason:'no-date' }`
 *                                       (importing undated would overwrite the
 *                                       prior snapshot — surface, don't guess)
 *
 * So it only ever WRITES when it's confident: a known document + a detected date.
 */

export interface AutoImportResult {
  imported: boolean;
  /** Why it didn't import, when `imported` is false but a match was found. */
  reason?: 'no-date';
  asOf: string | null;
  matchedCount: number;
  totalEntities: number;
  tables: string[];
  rows: number;
}

function existingDataTables(db: Lattice): ExistingTable[] {
  const native = new Set<string>(NATIVE_ENTITY_NAMES);
  const out: ExistingTable[] = [];
  for (const t of db.getRegisteredTableNames()) {
    if (native.has(t)) continue;
    const columns = Object.keys(db.getRegisteredColumns(t) ?? {});
    if (columns.length > 0) out.push({ name: t, columns });
  }
  return out;
}

async function readStructured(abs: string): Promise<Record<string, unknown>> {
  if (/\.xlsx?$/i.test(abs)) return excelToRecords(abs);
  return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
}

export async function autoImportStructured(
  db: Lattice,
  configPath: string | null,
  abs: string,
  name: string,
): Promise<AutoImportResult | null> {
  if (!/\.(xlsx?|json)$/i.test(name)) return null;
  let data: Record<string, unknown>;
  try {
    data = await readStructured(abs);
  } catch {
    return null; // not structured data we can model — leave it as a reference file
  }
  const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
    inferSchema(data),
    data,
  );
  if (inferredPlan.entities.length === 0) return null;

  const match = matchSchemaToExisting(existingDataTables(db), inferredPlan);
  if (!match.isKnownDocument) return null; // unknown structure — not an auto-import

  const candidates = await detectImportAsOf(db, data, { abs, fileName: name });
  const asOf = candidates[0]?.date ?? null;
  if (!asOf) {
    // Recognized, but importing undated would overwrite the existing snapshot —
    // tell the caller so it can ask for the date rather than guess.
    return {
      imported: false,
      reason: 'no-date',
      asOf: null,
      matchedCount: match.matchedCount,
      totalEntities: match.totalEntities,
      tables: [],
      rows: 0,
    };
  }

  const { plan, views } = renameEntities(inferredPlan, inferredViews, match.rename);
  const result = await materializeImport({ db, configPath }, data, plan, views, { asOf });
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  return {
    imported: true,
    asOf,
    matchedCount: match.matchedCount,
    totalEntities: match.totalEntities,
    tables: Object.keys(result.rowsByTable),
    rows,
  };
}
