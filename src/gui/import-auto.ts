import { readFileSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { excelFormulaSummary, excelImportWarnings, excelToRecords } from '../import/excel.js';
import { csvToRecords } from '../import/csv.js';
import { docxToRecords, pptxToRecords } from './ai/doc/doc-tables.js';
import { pdfToRecords } from '../import/pdf-tables.js';
import {
  buildComputedProposals,
  type ComputedTableProposal,
} from '../import/computed-proposals.js';
import { matchSchemaToExisting, type ExistingTable } from '../import/match.js';
import { normalizeName } from '../import/infer-core.js';
import { materializeImport } from '../import/materialize.js';
import { MAX_IMPORT_TABLES, applySourceNameFallback } from '../import/name-policy.js';
import { MAX_WORKBOOK_TABLES, splitSheetJobs } from '../import/sheet-jobs.js';
import { buildImportPlan, documentsKeptAsFilesNotice } from '../import/front-door.js';
import { checkSourceIsDuplicate } from '../import/duplicate-source.js';
import { planSourceFor } from '../import/plan-source.js';
import type { NameAssist } from './import-naming.js';
import type { FeedBus } from './feed.js';
import { recordImportActivity } from './mutations.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { getClarifyThreshold } from '../ops/ai-config.js';
import { isAnyProviderConfigured } from './ai/provider.js';
import { detectImportAsOf } from './import-detect.js';
import { detectAsOfColumns } from '../import/asof-columns.js';

/**
 * Automatic structured import for a file dropped into the assistant. The importer
 * is reachable ONLY through this single chat-upload door. A drop imports with no
 * decisions to make — the client materializes every case silently through the
 * apply route; there is no confirm card. Behavior:
 *
 *   - not parseable as structured data → null (kept as a plain reference file)
 *   - no entities inferred             → null
 *   - matches an existing dataset + a CONFIDENT date → silent import as a dated
 *     snapshot (`imported:true`), no preview, no Q&A
 *   - matches an existing dataset but NO/ambiguous date → `reason:'needs-confirm'`
 *     + a full proposal; the client imports it silently, and the apply route files
 *     it as a NEW snapshot dated by the import date so the prior one is never
 *     overwritten (undated in-place upsert is what would clobber it)
 *   - brand-new structured data (no match) → `reason:'new-dataset'` + a full
 *     proposal; the client imports it silently through the apply route
 *
 * The proposal fields ride along for the client's silent executor + reporting; the
 * apply route (`/api/import/apply`) re-reads the file's bytes from its `fileId` and
 * re-derives everything, so those fields are informational.
 */

export interface AutoImportResult {
  imported: boolean;
  /** When `imported` is false: why, and which inline card to show. */
  reason?: 'needs-confirm' | 'new-dataset';
  asOf: string | null;
  matchedCount: number;
  totalEntities: number;
  tables: string[];
  /**
   * The subset of `tables` this import CREATED (new to the workspace). Distinct
   * from `tables`, which is everything it wrote: a recognized re-import writes
   * tables that were already there and creates none. The distinction decides what
   * the change-log entry can honestly tell somebody to delete to take the import
   * back — "delete the tables it created" is ruinous advice about a table already
   * holding earlier snapshots.
   */
  tablesCreated?: string[];
  rows: number;
  /**
   * Per-table row counts of what this import produced (or, for a proposal, what it
   * WOULD produce). Carried so a caller holding the document's prose can reconcile
   * those counts against the counts the document states — the whole-import `rows`
   * total can't answer "did the schools table get all 46 of them?".
   */
  rowsByTable?: Record<string, number>;
  // ── Proposal payload for the inline confirm card (present when `reason` is set).
  /** The dropped file's `files` row id — the apply route resolves it to the blob. */
  fileId?: string;
  plan?: Awaited<ReturnType<typeof dedupeAndDetectViews>>['plan'];
  views?: Awaited<ReturnType<typeof dedupeAndDetectViews>>['views'];
  asOfCandidates?: Awaited<ReturnType<typeof detectImportAsOf>>;
  asOfColumns?: Awaited<ReturnType<typeof detectAsOfColumns>>;
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
   *  table was imported) — surfaced through the import task + feed so a partial import is
   *  never silent. */
  importWarnings?: string[];
  /**
   * Outcomes of the import that the user would otherwise never see: a table the
   * shape contract refused, tables named positionally for want of a model,
   * documents kept as files because nothing was configured to read them. These
   * are reported rather than logged, because every one of them changes what the
   * user ends up with.
   */
  notices?: string[];
}

// ── Stated-count reconciliation ────────────────────────────────────────────
//
// A document usually says how much it contains ("46 schools", "a total of 900
// students"). When extraction yields FEWER rows than the document itself claims,
// the user has silently lost data — the import "succeeded" while two thirds of it
// never landed. That gap is reported through the same `notices` channel as every
// other outcome-changing result (a refused table, documents kept as files), so a
// partial extraction is never presented as a clean one.
//
// The detector is deliberately CONSERVATIVE: a stated count is reported only when
// its subject resolves to a table that extraction actually wrote, and only when the
// stated number EXCEEDS the extracted row count. Prose counts with no matching
// table ("3 reasons"), a stated subset ("12 schools in the north region" out of 46),
// and years are all silent.

/** One "the document says N, we extracted fewer" discrepancy. */
export interface StatedCountMismatch {
  /** The subject as written in the document (e.g. `charter schools`). */
  subject: string;
  /** The count the document states. */
  stated: number;
  /** Rows extraction actually produced for the matching table. */
  extracted: number;
  /** The extracted table the subject resolved to. */
  table: string;
}

/** Words that make a following 4-digit number a DATE rather than a quantity. */
const TEMPORAL_BEFORE_YEAR = new Set([
  'in',
  'since',
  'by',
  'during',
  'from',
  'until',
  'through',
  'after',
  'before',
  'circa',
  'fy',
]);

/** Longest prose span scanned for stated counts. Extraction text is already
 *  bounded upstream; this keeps the scan cost flat on a pathological document. */
const MAX_RECONCILE_CHARS = 500_000;

/**
 * A comparison key that makes `schools` / `school` / `Charter Schools` all equal:
 * the shared name normalizer, then a best-effort singularization of the final word.
 */
function countKey(phrase: string): string {
  const norm = normalizeName(phrase);
  const parts = norm.split('_');
  const last = parts[parts.length - 1];
  if (last === undefined || last.length < 3) return norm;
  let singular = last;
  if (last.endsWith('ies')) singular = last.slice(0, -3) + 'y';
  else if (/(s|x|z|ch|sh)es$/.test(last)) singular = last.slice(0, -2);
  else if (/[^s]s$/.test(last)) singular = last.slice(0, -1);
  parts[parts.length - 1] = singular;
  return parts.join('_');
}

/**
 * Counts a document STATES that exceed what extraction produced.
 *
 * `rowsByTable` is the real per-table row count of what was written. Pure and
 * synchronous — same text + counts in, same discrepancies out — so the decision is
 * unit-testable without a DB, a model, or an import.
 */
export function findStatedCountMismatches(
  text: string,
  rowsByTable: Record<string, number>,
): StatedCountMismatch[] {
  const tables = Object.keys(rowsByTable);
  if (!text || tables.length === 0) return [];
  // key → the table it names. First writer wins, so two tables normalizing to the
  // same key resolve deterministically to the earlier one.
  const byKey = new Map<string, string>();
  for (const t of tables) {
    const k = countKey(t);
    if (!byKey.has(k)) byKey.set(k, t);
  }
  const scan = text.length > MAX_RECONCILE_CHARS ? text.slice(0, MAX_RECONCILE_CHARS) : text;
  // A number (optionally thousands-grouped), any decimal tail, then up to three
  // words — the candidate subject. The decimal tail is captured so "4.6 schools"
  // can be recognized as a rate and skipped rather than read as "4 schools".
  const re =
    /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s+((?:[A-Za-z][A-Za-z'-]*\s+){0,2}[A-Za-z][A-Za-z'-]*)/g;
  /** table → the largest count the document stated for it. */
  const statedByTable = new Map<string, { stated: number; subject: string }>();
  for (const m of scan.matchAll(re)) {
    const digits = m[1];
    const decimal = m[2];
    const phrase = m[3];
    if (digits === undefined || phrase === undefined) continue;
    if (decimal) continue; // a rate/measure, not a count of things
    const stated = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(stated) || stated <= 0) continue;
    // A bare 4-digit number introduced by a temporal word is a date.
    if (!digits.includes(',') && digits.length === 4 && stated >= 1900 && stated <= 2100) {
      const before = scan.slice(Math.max(0, m.index - 24), m.index).trim();
      const priorWord = (/([A-Za-z]+)\W*$/.exec(before)?.[1] ?? '').toLowerCase();
      if (TEMPORAL_BEFORE_YEAR.has(priorWord)) continue;
    }
    // Resolve the LONGEST leading word-run of the subject that names a real table,
    // so "46 charter schools" prefers `charter_schools` over `schools`.
    const words = phrase.split(/\s+/).filter(Boolean);
    let matched: { table: string; subject: string } | null = null;
    for (let n = 1; n <= words.length; n++) {
      const candidate = words.slice(0, n).join(' ');
      const table = byKey.get(countKey(candidate));
      if (table) matched = { table, subject: candidate };
    }
    if (!matched) continue;
    const prior = statedByTable.get(matched.table);
    if (!prior || stated > prior.stated) {
      statedByTable.set(matched.table, { stated, subject: matched.subject });
    }
  }
  const out: StatedCountMismatch[] = [];
  for (const [table, { stated, subject }] of statedByTable) {
    const extracted = rowsByTable[table] ?? 0;
    if (stated > extracted) out.push({ subject, stated, extracted, table });
  }
  return out;
}

/**
 * {@link findStatedCountMismatches} rendered as user-facing notices — the same
 * `notices` array that carries every other "this changed what you ended up with"
 * outcome, so a shortfall rides the existing report instead of a parallel channel.
 */
export function statedCountNotices(text: string, rowsByTable: Record<string, number>): string[] {
  return findStatedCountMismatches(text, rowsByTable).map(
    (m) =>
      `This document states ${String(m.stated)} ${m.subject}, but only ` +
      `${String(m.extracted)} row${m.extracted === 1 ? '' : 's'} were extracted into "${m.table}" — ` +
      `${String(m.stated - m.extracted)} may be missing. Check the source before relying on this table.`,
  );
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
  //
  // Every branch runs through applySourceNameFallback so an anonymous top-level
  // key (Excel's default `Sheet1`, a JSON `table_1`) is renamed from the FILE
  // name before inference — without it, the materialize pre-flight would refuse
  // a default-named workbook outright. The apply route (import-routes
  // readImportSourceFromFile) applies the same fallback with the same
  // original_name, so both doors keep naming identically (doors parity).
  if (/\.xlsx?$/i.test(name)) return applySourceNameFallback(await excelToRecords(abs), name);
  if (/\.(csv|tsv)$/i.test(name)) return applySourceNameFallback(csvToRecords(abs, name), name);
  // Documents: extract embedded tables (every row) so a .docx/.pptx of tabular data
  // flows through the same deterministic importer as a spreadsheet instead of falling
  // to the model. A doc with no tables → {} → autoImportStructured infers no entities
  // and returns null (kept as a reference file + text-ingested for its prose).
  // `name` doubles as the naming-ladder fallback label (rung 4 + the fold); the
  // fallback pass after it is a no-op safety net for the ladder's output.
  if (/\.docx$/i.test(name)) return applySourceNameFallback(await docxToRecords(abs, name), name);
  if (/\.pptx$/i.test(name)) return applySourceNameFallback(await pptxToRecords(abs, name), name);
  // PDFs carry no table markup — their ruled tables are recovered from text
  // geometry. A PDF with no aligned columns yields {} and falls through to being
  // kept as a document, exactly like a .docx with no tables.
  if (/\.pdf$/i.test(name)) return applySourceNameFallback(await pdfToRecords(abs, name), name);
  return applySourceNameFallback(
    JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>,
    name,
  );
}

/** True when a parsed document's extracted tables include at least one SUBSTANTIVE table
 *  (>=2 columns AND >=2 data rows) — a real dataset, not an incidental layout table.
 *  Exported so tests assert against the REAL predicate, not a reimplementation. */
export function hasSubstantiveDocTable(data: Record<string, unknown>): boolean {
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

export async function autoImportStructured(
  db: Lattice,
  configPath: string | null,
  abs: string,
  name: string,
): Promise<AutoImportResult | null> {
  if (!/\.(xlsx?|csv|tsv|json|docx|pptx|pdf)$/i.test(name)) return null;
  // Duplicate FIRST, before any parsing or inference. Re-adding a file the
  // workspace already holds byte-for-byte is not a new import: the ingest dedup
  // pass merges the row onto the existing copy, and re-importing here would add a
  // second snapshot (or raise a second proposal) for data that is already in.
  const duplicate = await checkSourceIsDuplicate(db, abs);
  if (duplicate.duplicateOfFileId) return null;
  let data: Record<string, unknown>;
  try {
    data = await readStructured(abs, name);
  } catch {
    return null; // not structured data we can model — leave it as a reference file
  }
  // Documents: only propose a structured import when the extracted tables are SUBSTANTIVE
  // (>=2 columns AND >=2 rows) — a real dataset, not an incidental layout/instructions table.
  // Otherwise keep the doc as a plain reference file rather than erroring or over-importing.
  if (/\.(docx|pptx|pdf)$/i.test(name) && !hasSubstantiveDocTable(data)) {
    // With a model configured the document goes on to text extraction, so there
    // is nothing to report. Without one it stops here for good — the user gets a
    // file and no data, which until now happened silently. Say it instead.
    if (await isAnyProviderConfigured(db)) return null;
    return {
      imported: false,
      asOf: null,
      matchedCount: 0,
      totalEntities: 0,
      tables: [],
      rows: 0,
      notices: [documentsKeptAsFilesNotice(1)],
    };
  }
  // The user's clarify threshold decides which inferred links are created vs
  // asked about; carried on the proposal so apply uses the same bar.
  const linkConfidence = getClarifyThreshold();
  const existing = existingDataTables(db);
  // A multi-sheet Excel workbook is materialized per sheet on apply, so the whole-workbook
  // proposal is judged against the high overall ceiling rather than the per-import cap — a
  // 77-tab book is not "over the safe limit", it is 77 small imports. Non-Excel keeps the cap.
  const sheetCount = /\.xlsx?$/i.test(name) ? splitSheetJobs(data).length : 1;
  // The front door owns naming + the shape contract for every import path. The
  // name assist is deliberately NOT wired here: this door only PROPOSES, and the
  // confirm-card apply re-derives the plan from the same bytes on its own. A
  // non-deterministic naming step would let the two disagree about what the
  // tables are called, so this door stays on the deterministic ladder.
  const front = await buildImportPlan({
    data,
    source: planSourceFor(name),
    existing,
    registered: db.getRegisteredTableNames(),
    minLinkConfidence: linkConfidence,
    ...(sheetCount > 1 ? { maxTables: MAX_WORKBOOK_TABLES } : {}),
  });
  data = front.data;
  const inferredPlan = front.plan;
  const inferredViews = front.views;
  if (inferredPlan.entities.length === 0) return null;

  const schemaMatch = front.schemaMatch;
  const asOfCandidates = await detectImportAsOf(db, data, { abs, fileName: name });
  const asOf = asOfCandidates[0]?.date ?? null;
  const asOfColumns = await detectAsOfColumns(data, inferredPlan);
  // Reconciliation warnings from the Excel read (a stacked-table sheet only partially
  // imported) — surfaced on the confirm card so the user sees a partial import before applying.
  const importWarnings = /\.xlsx?$/i.test(name) ? excelImportWarnings(abs) : [];
  // Per-table counts the proposal WOULD produce, so a caller holding the document's
  // prose can reconcile "the document says 46" against a plan that only found 12 —
  // before the user confirms, not after.
  const plannedRowsByTable: Record<string, number> = {};
  for (const e of inferredPlan.entities) plannedRowsByTable[e.name] = e.rowCount;
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
    rowsByTable: plannedRowsByTable,
    linkConfidence,
    ...(importWarnings.length > 0 ? { importWarnings } : {}),
    ...(front.notices.length > 0 ? { notices: front.notices } : {}),
  };

  // Brand-new structured data → a 'new-dataset' proposal the client imports SILENTLY through
  // the apply route (no confirm card, no decisions). An unreasonable fan-out is still bounded:
  // the per-import table cap is enforced server-side at apply time (a many-sheet workbook is
  // split per sheet under the cap; any other over-cap source fails loudly there), so the drop
  // does not need a client-side interrupt to stay safe.
  if (!schemaMatch.isKnownDocument) {
    const computedProposals = buildComputedProposals({
      data,
      plan: inferredPlan,
      rename: schemaMatch.rename,
      // The formula summary was cached by the excelToRecords read above.
      formulaSummary: /\.xlsx?$/i.test(name) ? excelFormulaSummary(abs) : null,
      existingTables: existing.map((t) => t.name),
    });
    return {
      imported: false,
      reason: 'new-dataset',
      asOf,
      ...proposal,
      computedProposals,
    };
  }
  // Recognized as a known dataset but no confident date. Materializing it here (imported:true)
  // undated would upsert in place and clobber the prior import, so this door does NOT commit —
  // it returns a 'needs-confirm' proposal. The client still imports it silently, and the apply
  // route stamps it with the import date so it lands as a NEW dated snapshot beside the prior
  // one rather than overwriting it.
  if (!asOf) {
    return { imported: false, reason: 'needs-confirm', asOf: null, ...proposal };
  }

  // Known document + a confident date → silent import as a dated snapshot.
  const { plan, views } = front.matched;
  const result = await materializeImport({ db, configPath }, data, plan, views, { asOf });
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  return {
    imported: true,
    asOf,
    matchedCount: schemaMatch.matchedCount,
    totalEntities: schemaMatch.totalEntities,
    tables: Object.keys(result.rowsByTable),
    tablesCreated: result.tablesCreated,
    rows,
    rowsByTable: result.rowsByTable,
    ...(front.notices.length > 0 ? { notices: front.notices } : {}),
  };
}

/** The faithful materialization of a parsed structured dataset (all rows). */
export interface FaithfulImportResult {
  /** Tables created/updated by the import. */
  tables: string[];
  /** The subset of `tables` that did not exist before this import ran. */
  tablesCreated: string[];
  /** Total rows materialized across those tables. */
  rows: number;
  /** Per-table row counts, for reconciling against counts the source document states. */
  rowsByTable: Record<string, number>;
  /** Outcomes worth telling the user about (see {@link AutoImportResult.notices}). */
  notices: string[];
}

export interface FaithfulImportOptions {
  /** The file the records came from — the naming ladder's fallback label. */
  sourceName?: string;
  /** Bounded name assist. This door commits once, so a model may name here. */
  nameAssist?: NameAssist | null;
  /**
   * The workspace's activity feed. Given one, this door writes the same change-log
   * entry as every other import door — what landed, and the plain statement that
   * it cannot be undone in one step. Without it the import still happens but
   * leaves no record, which is what every door here used to do.
   */
  feed?: FeedBus;
}

/**
 * Materialize an already-parsed structured dataset into real tables IMMEDIATELY and
 * FAITHFULLY (every row), through the same import front door as every other path —
 * name → infer → shape gate → match to existing tables → materialize.
 * Unlike {@link autoImportStructured} (whose new-dataset path only PROPOSES, never creating
 * tables from a passive drop), this is the executor for an EXPLICIT user request to import
 * a file they attached, so it commits. Returns null when the data has no inferable
 * entities (nothing to import).
 *
 * Given a `feed`, the import is written into the change log exactly as the other
 * doors write it — and, like them, that entry says plainly that an import cannot
 * be undone in one step and what to delete instead. (An earlier version of this
 * comment claimed every write here was "auditable + reversible like any other".
 * Neither half was true: this path wrote nothing to the audit log at all, and no
 * recorded row inverse removes a table that did not exist before.)
 *
 * When the data DID contain tables but the shape contract refused all of them, this
 * throws rather than returning null: the user asked for an import, and "nothing
 * happened" with no reason is the outcome this whole path exists to stop.
 */
export async function importDataFaithfully(
  db: Lattice,
  configPath: string | null,
  data: Record<string, unknown>,
  opts: FaithfulImportOptions = {},
): Promise<FaithfulImportResult | null> {
  const sourceName = opts.sourceName ?? '';
  // A multi-sheet Excel workbook with more sheets than the whole-import table cap is over-cap
  // by construction, so it goes straight to the per-sheet split WITHOUT first paying for a
  // whole-workbook plan whose cross-sheet inference would only be discarded when the split
  // re-infers each sheet. Smaller workbooks fall through to the exact-count check below (a
  // sub-cap sheet count can still fan out past the cap via dimensions), and any non-Excel
  // over-cap source still refuses loudly there — there is no per-sheet split to fall back on.
  if (/\.xlsx?$/i.test(sourceName)) {
    const jobs = splitSheetJobs(data);
    if (jobs.length > MAX_IMPORT_TABLES) {
      return recordFaithfulImport(
        db,
        opts,
        await importWorkbookPerSheet(db, configPath, jobs, opts),
      );
    }
  }
  const front = await faithfulFront(db, data, opts);
  if (front.plan.entities.length === 0) {
    if (front.dropped.length === 0) return null; // nothing to import — not a failure
    throw new Error(
      `Nothing could be imported from ${sourceName || 'this file'}. ` + front.notices.join(' '),
    );
  }
  // The whole-workbook plan is over the per-import cap. A LARGE multi-sheet Excel workbook is
  // not refused for it — it is imported per sheet, each sheet its own small unit under the
  // cap, so a 77-tab book lands instead of dead-ending. Cross-sheet foreign keys are given up
  // here and re-derived over the whole workspace afterwards. Any OTHER over-cap source (a
  // single sheet that fans out, a JSON of 50+ arrays) still refuses loudly — there is no
  // per-sheet split to fall back on, and committing it unreviewed is the outcome the cap stops.
  if (front.overCap) {
    const jobs = splitSheetJobs(data);
    if (/\.xlsx?$/i.test(sourceName) && jobs.length > 1) {
      return recordFaithfulImport(
        db,
        opts,
        await importWorkbookPerSheet(db, configPath, jobs, opts),
      );
    }
    throw new Error(
      `This import would create ${String(front.tableCount)} tables, over the safe limit of ` +
        `${String(MAX_IMPORT_TABLES)}. Import a narrower file, or use the import panel to review it.`,
    );
  }
  const { plan, views } = front.matched;
  const result = await materializeImport({ db, configPath }, front.data, plan, views, {});
  const rows = Object.values(result.rowsByTable).reduce((a, b) => a + b, 0);
  return recordFaithfulImport(db, opts, {
    tables: Object.keys(result.rowsByTable),
    tablesCreated: result.tablesCreated,
    rows,
    rowsByTable: result.rowsByTable,
    notices: front.notices,
  });
}

/**
 * Write this door's import into the change log, the same entry every other import
 * door writes — what landed, and the plain statement that it cannot be undone in
 * one step (see `recordImportActivity`). A caller that gave no feed gets the
 * result unchanged; an import that made nothing has nothing to record.
 */
async function recordFaithfulImport(
  db: Lattice,
  opts: FaithfulImportOptions,
  result: FaithfulImportResult | null,
): Promise<FaithfulImportResult | null> {
  if (!result || !opts.feed) return result;
  if (result.tablesCreated.length === 0 && Object.keys(result.rowsByTable).length === 0) {
    return result;
  }
  await recordImportActivity(
    db,
    opts.feed,
    {
      source: opts.sourceName ?? '',
      tablesCreated: result.tablesCreated,
      rowsByTable: result.rowsByTable,
      // This door materializes undated (re-importing upserts in place by natural
      // key), so there is no snapshot to name.
      asOf: null,
      asOfColumn: null,
    },
    'ai',
  );
  return result;
}

/**
 * Build the front-door plan for one already-parsed source unit. `registered` is always
 * read live so per-sheet jobs run sequentially with name collisions resolving as tables
 * are created. The snapshot-MATCH set (`existing`) is passed in by a caller that wants it
 * frozen: a per-sheet workbook split freezes it to the pre-workbook tables so sibling tabs
 * are not folded into each other, while the single-unit door defaults to the live tables.
 */
async function faithfulFront(
  db: Lattice,
  data: Record<string, unknown>,
  opts: FaithfulImportOptions,
  existing?: ExistingTable[],
): Promise<Awaited<ReturnType<typeof buildImportPlan>>> {
  return buildImportPlan({
    data,
    source: planSourceFor(opts.sourceName ?? ''),
    existing: existing ?? existingDataTables(db),
    registered: db.getRegisteredTableNames(),
    minLinkConfidence: getClarifyThreshold(),
    ...(opts.nameAssist ? { nameAssist: opts.nameAssist } : {}),
  });
}

/**
 * Materialize a multi-sheet workbook as many independent per-sheet units. Each sheet is
 * planned and materialized on its own, sequentially, so a later sheet sees the tables the
 * earlier ones created. The old whole-workbook cap becomes:
 *   - per sheet: a single sheet that fans out beyond {@link MAX_IMPORT_TABLES} is SKIPPED
 *     with a notice (pathological — import it on its own to review it), not a dead-end that
 *     sinks the other 76 sheets;
 *   - per workbook: a high overall ceiling ({@link MAX_WORKBOOK_TABLES}); when it is reached
 *     the remaining sheets are left for a separate import and that is REPORTED.
 * Neither is a silent drop and neither refuses the whole workbook.
 */
async function importWorkbookPerSheet(
  db: Lattice,
  configPath: string | null,
  jobs: ReturnType<typeof splitSheetJobs>,
  opts: FaithfulImportOptions,
): Promise<FaithfulImportResult | null> {
  const tables: string[] = [];
  const tablesCreated: string[] = [];
  const rowsByTable: Record<string, number> = {};
  const notices: string[] = [];
  let refused = false;
  let failed = false;
  // Tracked for the honest end-of-workbook aggregate (how many sheets landed; which failed).
  let importedSheets = 0;
  const failedSheets: string[] = [];
  // Match each sheet against the tables ALREADY in the workspace before this workbook
  // started — never against a table an earlier sibling sheet just created — so sibling tabs
  // that share a column signature stay distinct tables instead of one collapsing into
  // another (and, in this undated faithful path, overwriting it by natural key). A genuine
  // re-import of a whole workbook still matches its prior version's tables in this snapshot.
  const existingBefore = existingDataTables(db);
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job) continue;
    try {
      const front = await faithfulFront(db, job.data, opts, existingBefore);
      notices.push(...front.notices);
      if (front.plan.entities.length === 0) {
        // A prose / empty / gate-refused sheet models no table. That is not a failure of the
        // whole workbook — skip it; its refusal notices (if any) already rode along above.
        if (front.dropped.length > 0) refused = true;
        continue;
      }
      if (front.overCap) {
        notices.push(
          `Sheet "${job.key}" would create ${String(front.tableCount)} tables, over the ` +
            `per-sheet limit of ${String(MAX_IMPORT_TABLES)} — skipped. Import that sheet on ` +
            `its own to review it.`,
        );
        continue;
      }
      if (tables.length + front.tableCount > MAX_WORKBOOK_TABLES) {
        notices.push(
          `Imported ${String(tables.length)} tables, reaching the overall workbook limit of ` +
            `${String(MAX_WORKBOOK_TABLES)}. The remaining ${String(jobs.length - i)} sheet(s) ` +
            `were not imported — import them separately.`,
        );
        break;
      }
      const { plan, views } = front.matched;
      const result = await materializeImport({ db, configPath }, front.data, plan, views, {});
      for (const [t, n] of Object.entries(result.rowsByTable)) {
        if (!tables.includes(t)) tables.push(t);
        rowsByTable[t] = n;
      }
      for (const t of result.tablesCreated) {
        if (!tablesCreated.includes(t)) tablesCreated.push(t);
      }
      importedSheets++;
    } catch (e) {
      // One sheet's runtime failure must not sink the whole workbook: the sheets that
      // already imported are committed (materialize has no enclosing transaction), the
      // remaining sheets still run, and the failure is surfaced through the notices channel
      // rather than swallowed — so the caller's result reflects what really landed.
      failed = true;
      failedSheets.push(job.key);
      notices.push(
        `Sheet "${job.key}" could not be imported: ${(e as Error).message} — the other sheets ` +
          `were imported; import this sheet on its own to see the full error.`,
      );
      continue;
    }
  }
  if (tables.length === 0) {
    // Nothing landed. If tables were REFUSED or a sheet FAILED (not merely absent), the user
    // asked to import a file that imported nothing — say why loudly, matching the single-unit
    // contract, rather than reporting a clean no-op.
    if (refused || failed) {
      throw new Error(`Nothing could be imported from this workbook. ${notices.join(' ')}`.trim());
    }
    return null;
  }
  // Honest aggregate: how many sheets landed, and — named, never swallowed — any that could not
  // be imported. The per-table result already carries what really committed; this makes a partial
  // workbook import legible instead of leaving the shortfall implicit.
  notices.push(
    `Imported ${String(tables.length)} table${tables.length === 1 ? '' : 's'} from ` +
      `${String(importedSheets)} of ${String(jobs.length)} sheet${jobs.length === 1 ? '' : 's'}` +
      (failedSheets.length > 0
        ? `; ${String(failedSheets.length)} could not be imported: ${failedSheets.join(', ')}`
        : ''),
  );
  const rows = Object.values(rowsByTable).reduce((a, b) => a + b, 0);
  return { tables, tablesCreated, rows, rowsByTable, notices };
}
