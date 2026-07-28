import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import type { ComputedTableDef, ComputedFieldDef } from '../config/types.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { sendJson, readJson, MAX_INGEST_BYTES } from './http.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import {
  materializeImport,
  type ImportMode,
  type MaterializeResult,
} from '../import/materialize.js';
import { MAX_IMPORT_TABLES, applySourceNameFallback } from '../import/name-policy.js';
import { localPathOf } from './files-routes.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import {
  excelFormulaSummary,
  excelFormulaSummaryForSheet,
  excelImportWarnings,
  excelImportWarningsForSheet,
  excelToRecords,
  type WorkbookFormulaSummary,
} from '../import/excel.js';
import {
  MAX_WORKBOOK_TABLES,
  parseSheetFileRef,
  splitSheetJobs,
  type SheetJob,
} from '../import/sheet-jobs.js';
import { csvToRecords } from '../import/csv.js';
import { docxToRecords, pptxToRecords } from './ai/doc/doc-tables.js';
import {
  buildComputedProposals,
  type ComputedFieldProposal,
} from '../import/computed-proposals.js';
import type { ProposedSchema } from '../import/types.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { getClarifyThreshold } from './assistant-routes.js';
import type { FeedBus } from './feed.js';

/**
 * Structured-source import — apply route. The importer is reachable only by
 * dropping a file in the assistant chat: `autoImportStructured` builds the
 * proposal at upload time and stamps it with the dropped file's `fileId` (its
 * `files` row id); this route materializes the proposal when the user confirms.
 * It re-reads the original bytes from the file's RETAINED blob (xlsx/json/csv are
 * in the retainable set) — there is no separate staging dir and no dashboard
 * coupling. Everything is RE-DERIVED server-side from those bytes (the upload's
 * proposal is display-only); the body's `linkConfidence` and `computed`
 * selections are the only client inputs beyond mode/date.
 * POST /api/import/apply
 *   { fileId, mode, asOf, asOfColumn, linkConfidence?, computed? } → NDJSON.
 */

/** Context the import-apply route needs from the active workspace. */
export interface ImportRouteDeps {
  db: Lattice;
  configPath: string;
  latticeRoot: string | undefined;
  validTables: Set<string>;
  softDeletable: Set<string>;
  /** Feed bus — the import publishes activity events through it (e.g. a note that
   *  low-confidence links were left unconnected). */
  feed: FeedBus;
  /**
   * Creates a computed table through the audited GUI op (view DDL + YAML +
   * audit + AI fill). Absent ⇒ computed opt-ins are reported as skipped.
   */
  createComputed?: (name: string, def: ComputedTableDef) => Promise<void>;
}

interface FileRow {
  id: string;
  original_name?: string | null;
  mime?: string | null;
  ref_kind?: string | null;
  ref_uri?: string | null;
  blob_path?: string | null;
}

/** A 400-carrying error so the handler answers a client mistake with 400. */
function badRequest(message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}

// The local-bytes path a retained files row points at is resolved by the SHARED, hardened
// files-routes `localPathOf` (imported): it gates a `local_ref` behind localFileOpenEnabled()
// (off on team cloud) and realpath-contains a blob_path to the workspace root. Using the shared
// resolver keeps this import read-sink from reading /proc/self/environ or another tenant's blob
// when a `files` row's location columns are forged (the same guard the blob route relies on).

/** The importable (registered, non-native) data tables, for schema matching. */
export function existingDataTables(db: Lattice): ExistingTable[] {
  const native = new Set<string>(NATIVE_ENTITY_NAMES);
  const out: ExistingTable[] = [];
  for (const t of db.getRegisteredTableNames()) {
    if (native.has(t)) continue;
    const columns = Object.keys(db.getRegisteredColumns(t) ?? {});
    if (columns.length > 0) out.push({ name: t, columns });
  }
  return out;
}

/**
 * Re-read a previously-uploaded structured file's records from its retained
 * blob, choosing the parser from the row's original_name / mime (the blob is
 * content-addressed and extensionless). For an Excel source the per-column
 * formula summary gathered during the same read is returned too (null for
 * JSON) — both derive purely from the bytes, so they match what the upload
 * proposal saw. Throws a 400-mapped error if the row is gone or its bytes
 * aren't on this disk.
 */
export async function readImportSourceFromFile(
  db: Lattice,
  fileRef: string,
  latticeRoot: string | undefined,
): Promise<{
  data: Record<string, unknown>;
  formulaSummary: WorkbookFormulaSummary | null;
  importWarnings: string[];
  /** The source's original file name (drives parser choice + naming fallback). */
  name: string;
}> {
  // A reference may name the whole file (a bare files-row id) or a single sheet of a
  // multi-sheet workbook (`<id>#<sheet>`), so one sheet can be re-read + applied on its own.
  const { fileId, sheet } = parseSheetFileRef(fileRef);
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "id","original_name","mime","ref_kind","ref_uri","blob_path"
       FROM "files" WHERE "id" = ? AND "deleted_at" IS NULL LIMIT 1`,
    [fileId],
  )) as FileRow | undefined;
  if (!row) throw badRequest('Unknown import file: ' + fileId);
  const path = localPathOf(row, latticeRoot);
  if (!path || !existsSync(path)) {
    throw badRequest('The import file’s bytes are not available locally.');
  }
  // Bound the read: the apply route re-reads the retained bytes from disk, so it
  // must re-enforce the ingest cap — a row whose bytes were swapped/grew on disk
  // (or reached via a local_ref that never went through the upload cap) can't be
  // streamed whole into memory and OOM the process.
  const sizeBytes = statSync(path).size;
  if (sizeBytes > MAX_INGEST_BYTES) {
    throw badRequest(
      `The import file is too large (${String(Math.round(sizeBytes / 1_000_000))} MB); ` +
        `the limit is ${String(Math.round(MAX_INGEST_BYTES / 1_000_000))} MB.`,
    );
  }
  const name = row.original_name ?? '';
  const mime = row.mime ?? '';
  // Every branch runs through applySourceNameFallback with the row's
  // original_name — the SAME value import-auto's readStructured uses on the
  // upload door — so an anonymous top-level key (Excel's default `Sheet1`, a
  // JSON `table_1`) gets the same file-derived name on both doors (doors
  // parity), and the materialize pre-flight never refuses a default-named
  // workbook.
  if (/\.xlsx?$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel')) {
    const whole = await excelToRecords(path);
    // A per-sheet reference narrows to exactly one sheet (keyed by (path, sheet)); the
    // whole-file reference keeps every sheet. Either way the bytes are read once.
    if (sheet !== null) {
      const one = sheet in whole ? { [sheet]: whole[sheet] } : {};
      return {
        data: applySourceNameFallback(one, name),
        formulaSummary: excelFormulaSummaryForSheet(path, sheet),
        importWarnings: excelImportWarningsForSheet(path, sheet),
        name,
      };
    }
    return {
      data: applySourceNameFallback(whole, name),
      formulaSummary: excelFormulaSummary(path),
      importWarnings: excelImportWarnings(path),
      name,
    };
  }
  if (/\.(csv|tsv)$/i.test(name) || mime.includes('csv') || mime.includes('tab-separated')) {
    return {
      data: applySourceNameFallback(csvToRecords(path, name), name),
      formulaSummary: null,
      importWarnings: [],
      name,
    };
  }
  // Documents: extract embedded tables (every row) so the Apply route materializes a
  // .docx/.pptx the SAME way autoImportStructured proposed it — without this, a silent
  // import of a Word/PowerPoint file fails here with "not valid JSON".
  // `name` (the row's original_name) doubles as the naming-ladder fallback label.
  if (/\.docx$/i.test(name) || mime.includes('wordprocessingml')) {
    return {
      data: applySourceNameFallback(await docxToRecords(path, name), name),
      formulaSummary: null,
      importWarnings: [],
      name,
    };
  }
  if (/\.pptx$/i.test(name) || mime.includes('presentationml')) {
    return {
      data: applySourceNameFallback(await pptxToRecords(path, name), name),
      formulaSummary: null,
      importWarnings: [],
      name,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw badRequest('The import file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Expected a JSON object whose keys are record arrays.');
  }
  return {
    data: applySourceNameFallback(parsed as Record<string, unknown>, name),
    formulaSummary: null,
    importWarnings: [],
    name,
  };
}

/** The card's computed opt-in selection, sanitized from the request body. */
interface ComputedSelection {
  table: string;
  fields: string[];
}

function readComputedSelection(raw: unknown): ComputedSelection[] {
  if (!Array.isArray(raw)) return [];
  const out: ComputedSelection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { table, fields } = item as { table?: unknown; fields?: unknown };
    if (typeof table !== 'string' || !table.trim()) continue;
    const names = Array.isArray(fields)
      ? fields.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
      : [];
    if (names.length > 0) out.push({ table: table.trim(), fields: names });
  }
  return out;
}

/** Build the ComputedTableDef field for one selected proposal entry. */
function proposalToFieldDef(f: ComputedFieldProposal): ComputedFieldDef | null {
  if (f.kind === 'calc' && f.expr) return { kind: 'calc', expr: f.expr };
  if (f.kind === 'ai_classify' && f.input && f.prompt && f.labels && f.labels.length > 0) {
    return { kind: 'ai_classify', input: f.input, prompt: f.prompt, labels: f.labels };
  }
  return null;
}

/**
 * Count the marginal (low-confidence) links of a plan that survived as a plain scalar column a
 * later connect could read (an array reference has no such column, so it is not counted). Pure —
 * no side effects — so both the single-plan path and the per-sheet aggregate can sum across plans
 * before deciding whether to publish anything.
 */
export function countMarginalLinks(plan: ProposedSchema): number {
  return plan.marginalLinks.filter((link) => {
    const from = plan.entities.find((e) => e.name === link.fromEntity);
    return from?.columns.some((c) => c.sourceKey === link.fromField) ?? false;
  }).length;
}

/**
 * Publish the "left N links unconnected" activity note for a marginal-link count. A zero-decision
 * import never stops to ask and never fabricates an uncertain relationship, but it also never
 * leaves the choice INVISIBLE: the count is surfaced as a feed event so it can be made later from
 * the Data Model panel. No-op at count 0.
 */
export function publishMarginalLinksNote(deps: ImportRouteDeps, count: number): void {
  if (count === 0) return;
  const summary =
    `Left ${String(count)} possible link${count === 1 ? '' : 's'} unconnected ` +
    `(low confidence) — connect from the Data Model panel if they belong.`;
  // A general import note, not a row mutation — table:null keeps it non-clickable, like the
  // other non-row signals on the feed.
  deps.feed.publish({ table: null, op: 'schema', rowId: null, source: 'system', summary });
}

/**
 * Report the marginal (low-confidence) links of one materialized plan: count them, then publish
 * the activity note. Returns how many were reported (0 ⇒ nothing published).
 */
function reportMarginalLinks(deps: ImportRouteDeps, plan: ProposedSchema): number {
  const count = countMarginalLinks(plan);
  publishMarginalLinksNote(deps, count);
  return count;
}

/**
 * Materialize a large multi-sheet workbook as many independent per-sheet units, streaming
 * progress. Each sheet is inferred + matched + materialized on its own, sequentially, so a
 * later sheet sees the tables the earlier ones created. The whole-workbook table cap becomes
 * per sheet (a single sheet that fans out beyond {@link MAX_IMPORT_TABLES} is skipped with a
 * warning, not a dead-end for the other sheets) plus a high overall ceiling
 * ({@link MAX_WORKBOOK_TABLES}); reaching either is reported, never silent. Cross-sheet
 * foreign keys are not inferred here — they are re-derived over the whole workspace after.
 * Returns an aggregate {@link MaterializeResult} so the client's done handler reads it exactly
 * like a single-plan import.
 */
async function materializeWorkbookPerSheet(
  deps: ImportRouteDeps,
  jobs: SheetJob[],
  opts: {
    linkConfidence: number;
    asOf: string | null;
    asOfColumn: string | null;
    mode: ImportMode;
    emit: (p: Record<string, unknown>) => void;
  },
): Promise<MaterializeResult> {
  const { linkConfidence, asOf, asOfColumn, mode, emit } = opts;
  const tablesCreated: string[] = [];
  const rowsByTable: Record<string, number> = {};
  const links: MaterializeResult['links'] = [];
  const views: MaterializeResult['views'] = [];
  // Aggregated across all per-sheet plans, reported ONCE after the loop so the split path is as
  // honest as the single-plan path: the marginal (low-confidence) links left unconnected, the
  // count of sheets that landed, and the sheets that could not be imported.
  let marginalLinkCount = 0;
  let importedSheets = 0;
  const failedSheets: string[] = [];
  // Match each sheet against the tables ALREADY in the workspace before this workbook
  // started importing — never against a table an earlier sheet of the SAME workbook just
  // created. Recomputing the existing set inside the loop would fold sibling tabs that
  // share a column signature (monthly, per-region, paginated tabs) into the first tab's
  // table: many sheets would collapse into one, losing the per-sheet identity and dropping
  // rows whose signature values coincide across tabs. A genuine re-import of a whole
  // workbook still matches its prior version's tables — those are captured in this frozen
  // snapshot; only same-workbook siblings are kept apart.
  const existingBefore = existingDataTables(deps.db);
  emit({ phase: 'detect', message: `Importing ${String(jobs.length)} sheets, one at a time…` });
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job) continue;
    try {
      const { plan: inferredPlan, views: inferredViews } = await dedupeAndDetectViews(
        await inferSchema(job.data, { minLinkConfidence: linkConfidence }),
        job.data,
      );
      if (inferredPlan.entities.length === 0) continue; // a prose / empty / refused sheet — nothing to model
      const match = matchSchemaToExisting(existingBefore, inferredPlan);
      const { plan, views: renamedViews } = renameEntities(
        inferredPlan,
        inferredViews,
        match.rename,
      );
      const planned =
        plan.entities.length +
        plan.dimensions.length +
        new Set(plan.linkages.map((l) => l.junction).filter(Boolean)).size;
      if (planned > MAX_IMPORT_TABLES) {
        emit({
          phase: 'warning',
          message: `Sheet "${job.key}" would create ${String(planned)} tables, over the per-sheet limit of ${String(MAX_IMPORT_TABLES)} — skipped. Import that sheet on its own to review it.`,
        });
        continue;
      }
      if (tablesCreated.length + planned > MAX_WORKBOOK_TABLES) {
        emit({
          phase: 'warning',
          message: `Imported ${String(tablesCreated.length)} tables, reaching the overall workbook limit of ${String(MAX_WORKBOOK_TABLES)}. The remaining ${String(jobs.length - i)} sheet(s) were not imported — import them separately.`,
        });
        break;
      }
      emit({
        phase: 'materialize',
        message: `Importing sheet "${job.key}" (${String(i + 1)}/${String(jobs.length)})…`,
      });
      const result = await materializeImport(
        { db: deps.db, configPath: deps.configPath },
        job.data,
        plan,
        renamedViews,
        {
          mode,
          asOf,
          asOfColumn,
          onProgress: async (p) => {
            // Each sheet's own terminal 'done' is swallowed — the ONE aggregate 'done' is
            // emitted after every sheet, so the client completes the import exactly once.
            if (p.phase === 'done') return;
            emit({ ...p });
            await new Promise((r) => setImmediate(r));
          },
        },
      );
      for (const t of result.tablesCreated) {
        deps.validTables.add(t);
        const cols = deps.db.getRegisteredColumns(t);
        if (cols && 'deleted_at' in cols) deps.softDeletable.add(t);
        if (!tablesCreated.includes(t)) tablesCreated.push(t);
      }
      for (const [t, n] of Object.entries(result.rowsByTable)) rowsByTable[t] = n;
      links.push(...result.links);
      views.push(...result.views);
      // This sheet landed. Fold its marginal-link count into the workbook total (reported once
      // below) so the per-sheet path never silently drops a low-confidence link the single-plan
      // path would have surfaced.
      marginalLinkCount += countMarginalLinks(plan);
      importedSheets++;
    } catch (e) {
      // One sheet's runtime failure must not sink the whole workbook: the sheets that
      // already imported are committed (materialize has no enclosing transaction), the
      // remaining sheets still run, and the failure is surfaced here rather than swallowed —
      // so the aggregate result the client's done handler reads reflects what really landed
      // instead of the whole import reporting "nothing imported".
      failedSheets.push(job.key);
      emit({
        phase: 'warning',
        message: `Sheet "${job.key}" could not be imported: ${(e as Error).message} — the other sheets were imported; import this sheet on its own to see the full error.`,
      });
      continue;
    }
  }
  // Marginal links left unconnected across every sheet — one feed note + one stream line, matching
  // the single-plan path. Zero decisions, never silent.
  publishMarginalLinksNote(deps, marginalLinkCount);
  if (marginalLinkCount > 0) {
    emit({
      phase: 'detect',
      count: marginalLinkCount,
      message:
        `Left ${String(marginalLinkCount)} possible link${marginalLinkCount === 1 ? '' : 's'} ` +
        `unconnected (low confidence) — connect from the Data Model panel if they belong.`,
    });
  }
  // Honest aggregate: how many sheets landed, and — named, never swallowed — any that could not
  // be imported. The client's done handler shows the real per-table totals; this line makes a
  // partial workbook import legible instead of the earlier "nothing imported" when a sheet threw.
  const aggregate =
    `Imported ${String(tablesCreated.length)} table${tablesCreated.length === 1 ? '' : 's'} ` +
    `from ${String(importedSheets)} of ${String(jobs.length)} sheet${jobs.length === 1 ? '' : 's'}` +
    (failedSheets.length > 0
      ? `; ${String(failedSheets.length)} could not be imported: ${failedSheets.join(', ')}`
      : '');
  emit({ phase: 'detect', message: aggregate });
  return { mode, asOf, asOfColumn, tablesCreated, rowsByTable, links, views };
}

export async function dispatchImportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportRouteDeps,
): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method !== 'POST' || pathname !== '/api/import/apply') return false;

  const body = await readJson<{
    fileId?: unknown;
    mode?: unknown;
    asOf?: unknown;
    asOfColumn?: unknown;
    linkConfidence?: unknown;
    computed?: unknown;
    override?: unknown;
  }>(req).catch(() => ({}) as Record<string, unknown>);
  const fileId = typeof body.fileId === 'string' ? body.fileId : '';
  const mode: ImportMode = body.mode === 'schema' || body.mode === 'contents' ? body.mode : 'both';
  const asOf =
    typeof body.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf.trim())
      ? body.asOf.trim()
      : null;
  const asOfColumn =
    typeof body.asOfColumn === 'string' && body.asOfColumn.trim() ? body.asOfColumn.trim() : null;
  // Zero-decision snapshots — the no-overwrite guarantee. A passive drop carries no date
  // choice, but importing it undated upserts each row in place by natural key, so re-importing
  // the same dataset would silently clobber the prior import's values. Instead, stamp every
  // dateless import with the IMPORT DATE (server clock, UTC), making it a dated snapshot: row
  // identity folds in `as_of`, so a re-import on a later day APPENDS a new snapshot beside the
  // prior one, and a same-day re-import of identical data dedups (idempotent) rather than
  // overwriting. This holds from the very first import — the first drop of a dataset is itself
  // a dated snapshot — so a later known-document re-import always has a dated base to append to.
  // A source that DOES carry a file-level date (`asOf`) or dates each row (`asOfColumn`) keeps
  // its own dating and is unaffected.
  const effectiveAsOf = asOf ?? (asOfColumn ? null : new Date().toISOString().slice(0, 10));
  // The card echoes the threshold its proposal was inferred under, so the
  // re-derivation bands links the same way even if the preference changed
  // between upload and confirm. Clamped; absent ⇒ the current preference.
  const linkConfidence =
    typeof body.linkConfidence === 'number' && Number.isFinite(body.linkConfidence)
      ? Math.min(1, Math.max(0, body.linkConfidence))
      : getClarifyThreshold();
  const computedSelection = readComputedSelection(body.computed);
  if (!fileId) {
    sendJson(res, { error: 'fileId is required' }, 400);
    return true;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  const emit = (p: Record<string, unknown>): void => {
    res.write(JSON.stringify(p) + '\n');
  };
  try {
    emit({ phase: 'parse', message: 'Reading source…' });
    const { data, formulaSummary, importWarnings, name } = await readImportSourceFromFile(
      deps.db,
      fileId,
      deps.latticeRoot,
    );
    // Surface a stacked-table partial-import warning on the apply log — a partial import is
    // never silent (it also rode the confirm card + the post-import feed pill).
    for (const w of importWarnings) emit({ phase: 'warning', message: w });
    // A LARGE multi-sheet Excel workbook is not refused — it is imported per sheet, each
    // sheet its own small unit under the cap, so a 77-tab book lands instead of dead-ending.
    // When the workbook has MORE sheets than the whole-import table cap it is over-cap by
    // construction (each sheet is at least its own unit), so it takes the per-sheet split
    // WITHOUT first paying for a whole-workbook inference whose cross-sheet plan would only
    // be discarded when the split re-infers each sheet. Cross-sheet foreign keys are re-
    // derived over the whole workspace afterwards, so nothing is lost by splitting here.
    const workbookJobs = /\.xlsx?$/i.test(name) ? splitSheetJobs(data) : [];
    if (workbookJobs.length > MAX_IMPORT_TABLES) {
      emit({ phase: 'infer', message: 'Analyzing schema…' });
      const result = await materializeWorkbookPerSheet(deps, workbookJobs, {
        linkConfidence,
        asOf: effectiveAsOf,
        asOfColumn,
        mode,
        emit,
      });
      emit({ phase: 'done', ok: true, result });
      res.end();
      return true;
    }
    emit({ phase: 'infer', message: 'Analyzing schema…' });
    const { plan: inferredPlan, views: inferredViews } = await dedupeAndDetectViews(
      await inferSchema(data, { minLinkConfidence: linkConfidence }),
      data,
    );
    emit({
      phase: 'infer',
      message: `Found ${String(inferredPlan.entities.length)} entities, ${String(inferredPlan.dimensions.length)} dimensions, ${String(inferredPlan.linkages.length)} links`,
    });
    // Existing tables BEFORE materialize — the same set the upload proposal
    // matched against, so the re-derived computed proposals name identically.
    const existing = existingDataTables(deps.db);
    const match = matchSchemaToExisting(existing, inferredPlan);
    const { plan, views } = renameEntities(inferredPlan, inferredViews, match.rename);
    // Hard cap (defense in depth): never materialize an unreasonable number of tables from
    // one import without an explicit override. The confirm card sends override:true on Apply
    // (a user who reviewed the scope may proceed); a silent import or a direct/assistant
    // caller cannot blow the workspace up past the cap. Complements the client scale guard.
    const plannedTables =
      plan.entities.length +
      plan.dimensions.length +
      new Set(plan.linkages.map((l) => l.junction).filter(Boolean)).size;
    // A smaller multi-sheet workbook whose EXACT plan still exceeds the cap also splits per
    // sheet rather than dead-ending — the whole-workbook inference above was needed to learn
    // the exact count (a sheet count under the cap can still fan out past it via dimensions).
    if (workbookJobs.length > 1 && plannedTables > MAX_IMPORT_TABLES) {
      const result = await materializeWorkbookPerSheet(deps, workbookJobs, {
        linkConfidence,
        asOf: effectiveAsOf,
        asOfColumn,
        mode,
        emit,
      });
      emit({ phase: 'done', ok: true, result });
      res.end();
      return true;
    }
    if (plannedTables > MAX_IMPORT_TABLES && body.override !== true) {
      emit({
        phase: 'error',
        message: `This import would create ${String(plannedTables)} tables, over the safe limit of ${String(MAX_IMPORT_TABLES)}. Review and confirm the import to proceed.`,
      });
      res.end();
      return true;
    }
    if (views.length > 0) {
      emit({
        phase: 'detect',
        message: `Detected ${String(views.length)} reconstructable views (no duplicated rows)`,
      });
    }
    if (match.isKnownDocument) {
      emit({
        phase: 'detect',
        message: `Recognized as a new period of an existing document — ${String(match.matchedCount)} of ${String(match.totalEntities)} tables matched`,
      });
    }
    if (asOfColumn) {
      emit({ phase: 'infer', message: `Dating each row by its "${asOfColumn}" column` });
    } else if (asOf) {
      emit({ phase: 'infer', message: `Importing as a snapshot dated ${asOf}` });
    } else if (match.isKnownDocument && effectiveAsOf) {
      // A dateless re-import of a known document: it is filed under the import date as its own
      // snapshot so the prior import is preserved, not overwritten. Say so — the outcome differs
      // from what a naive undated re-import would do, so it must be visible.
      emit({
        phase: 'detect',
        message: `Filed as a new snapshot dated ${effectiveAsOf} — the prior import is kept.`,
      });
    }
    const result = await materializeImport(
      { db: deps.db, configPath: deps.configPath },
      data,
      plan,
      views,
      {
        mode,
        asOf: effectiveAsOf,
        asOfColumn,
        onProgress: async (p) => {
          emit({ ...p });
          await new Promise((r) => setImmediate(r));
        },
      },
    );
    for (const t of result.tablesCreated) {
      deps.validTables.add(t);
      const cols = deps.db.getRegisteredColumns(t);
      if (cols && 'deleted_at' in cols) deps.softDeletable.add(t);
    }

    // ── Opt-in computed tables ──
    // Re-derive the proposals from the same inputs the upload used and honor
    // the selection by NAME (the client payload is never trusted as a
    // definition). A computed-create failure is a warning — the import itself
    // has already succeeded and the raw columns are in.
    if (computedSelection.length > 0) {
      const proposals = buildComputedProposals({
        data,
        plan: inferredPlan,
        rename: match.rename,
        formulaSummary,
        existingTables: existing.map((t) => t.name),
      });
      const byTable = new Map(proposals.map((p) => [p.table, p]));
      for (const selection of computedSelection) {
        const proposal = byTable.get(selection.table);
        if (!proposal) {
          emit({
            phase: 'computed',
            message: `Skipping unknown computed table "${selection.table}"`,
          });
          continue;
        }
        const byField = new Map(proposal.fields.map((f) => [f.name, f]));
        const fields: Record<string, ComputedFieldDef> = {};
        for (const name of selection.fields) {
          const field = byField.get(name);
          const def = field ? proposalToFieldDef(field) : null;
          if (!def) {
            emit({
              phase: 'computed',
              message: `Skipping unknown computed field "${selection.table}.${name}"`,
            });
            continue;
          }
          fields[name] = def;
        }
        if (Object.keys(fields).length === 0) continue;
        if (!deps.createComputed) {
          emit({
            phase: 'computed',
            message: `Skipping computed table "${proposal.table}" — computed tables are unavailable here`,
          });
          continue;
        }
        emit({
          phase: 'computed',
          table: proposal.table,
          message: `Creating computed table ${proposal.table}…`,
        });
        try {
          await deps.createComputed(proposal.table, { base: proposal.entity, fields });
          emit({
            phase: 'computed',
            table: proposal.table,
            count: Object.keys(fields).length,
            message: `Computed table ${proposal.table}: ${String(Object.keys(fields).length)} field(s)`,
          });
        } catch (e) {
          emit({
            phase: 'computed',
            table: proposal.table,
            message: `Computed table ${proposal.table} failed: ${(e as Error).message}`,
          });
        }
      }
    }

    // ── Marginal links ──
    // Confidently-inferred links were materialized above. The marginal (low-confidence) band is
    // NOT connected — a zero-decision import never asks, and it also never fabricates an uncertain
    // relationship. Those references stay as plain text columns; the fact that they were left
    // unconnected is reported (feed event for the activity log + a line on this import stream) so
    // the choice is visible and can be made later from the Data Model panel.
    const leftUnconnected = reportMarginalLinks(deps, plan);
    if (leftUnconnected > 0) {
      emit({
        phase: 'detect',
        count: leftUnconnected,
        message:
          `Left ${String(leftUnconnected)} possible link${leftUnconnected === 1 ? '' : 's'} ` +
          `unconnected (low confidence) — connect from the Data Model panel if they belong.`,
      });
    }

    emit({ phase: 'done', ok: true, result });
  } catch (e) {
    emit({ phase: 'error', message: (e as Error).message });
  }
  res.end();
  return true;
}
