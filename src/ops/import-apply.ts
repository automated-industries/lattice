/**
 * Applying a structured import, headless.
 *
 * A spreadsheet, a CSV, a JSON export, a Word or PowerPoint file with tables in
 * it — reading one, working out the schema hiding inside it, recognising it as a
 * new period of something already held, and materializing it into real tables,
 * rows, and relationships. That is the operation; where the file came from is
 * not part of it.
 *
 * It used to be reachable one way only: drop the file into the assistant rail in
 * a browser, and confirm. Which meant the single most scriptable thing this
 * product does — "here is this month's workbook, import it" — could not be
 * scripted. A nightly job, a migration, a workspace being prepared from a folder
 * of exports: every one of them had to drive a browser or do without.
 *
 * So the pipeline lives here, taking a source somebody has already read and a
 * workspace to put it in. What stays behind in the request handler is transport:
 * resolving which uploaded file a browser meant, and streaming the progress lines
 * back as they happen. A command line reads the file itself and prints the same
 * lines; a library caller takes the result as a value.
 *
 * A REFUSAL IS A TAGGED ERROR, never a status: `ingestError` carries a code the
 * adapter maps to whatever its transport uses (see `./ingest-errors.js`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import type { ComputedTableDef, ComputedFieldDef } from '../config/types.js';
import type { FeedBus } from '../gui/feed.js';
import { MAX_INGEST_BYTES } from './paging.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import {
  materializeImport,
  type ImportMode,
  type MaterializeResult,
} from '../import/materialize.js';
import { MAX_IMPORT_TABLES, applySourceNameFallback } from '../import/name-policy.js';
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
import { docxToRecords, pptxToRecords } from '../gui/ai/doc/doc-tables.js';
import {
  buildComputedProposals,
  type ComputedFieldProposal,
} from '../import/computed-proposals.js';
import type { ProposedSchema } from '../import/types.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { recordImportActivity } from '../gui/mutations.js';
import { getClarifyThreshold } from './ai-config.js';
import { ingestError } from './ingest-errors.js';

/** Context an import needs from the workspace it is landing in. */
export interface ImportApplyDeps {
  db: Lattice;
  configPath: string;
  latticeRoot: string | undefined;
  validTables: Set<string>;
  softDeletable: Set<string>;
  /** Feed bus — the import publishes activity events through it (e.g. a note that
   *  low-confidence links were left unconnected). */
  feed: FeedBus;
  /**
   * Creates a computed table through the audited op (view DDL + YAML + audit +
   * AI fill). Absent ⇒ computed opt-ins are reported as skipped.
   */
  createComputed?: (name: string, def: ComputedTableDef) => Promise<void>;
}

/** A source that has been READ: its records, and what reading it revealed. */
export interface ImportSource {
  /** Records keyed by table name, ready to infer a schema from. */
  data: Record<string, unknown>;
  /** Per-column formula summary for an Excel source; null for everything else. */
  formulaSummary: WorkbookFormulaSummary | null;
  /** Anything about the read that changed what the caller ends up with. */
  importWarnings: string[];
  /** The source's original file name (drives parser choice + naming fallback). */
  name: string;
}

/** One line of an import's progress, as the pipeline reports it. */
export type ImportApplyEvent = Record<string, unknown>;

/** The card's computed opt-in selection. */
export interface ComputedSelection {
  table: string;
  fields: string[];
}

/** Everything an apply decides from, beyond the source and the workspace. */
export interface ImportApplyOptions {
  /** Structure, contents, or both (the default). */
  mode?: ImportMode;
  /** A file-level date for the whole import, `YYYY-MM-DD`. */
  asOf?: string | null;
  /** A per-row date column, when the source dates each record itself. */
  asOfColumn?: string | null;
  /** Link-confidence floor. Absent ⇒ this machine's current preference. */
  linkConfidence?: number | undefined;
  /** Computed tables the caller opted into, by name. Never trusted as definitions. */
  computed?: ComputedSelection[];
  /** Proceed past the safe table cap — for a caller that has reviewed the scope. */
  override?: boolean;
}

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
 * Read a structured source off this machine's disk into records, choosing the
 * parser from its NAME (the file may be a content-addressed blob with no
 * extension, so the name is what identifies it). For an Excel source the
 * per-column formula summary gathered during the same read is returned too.
 *
 * The read is BOUNDED: an oversized file is refused before it is opened, so a
 * source that grew (or was swapped) on disk cannot be streamed whole into memory.
 *
 * @param path where the bytes are right now
 * @param name the source's own file name, which decides the parser
 * @param sheet one sheet of a multi-sheet workbook, or null for the whole file
 */
export async function readImportSource(
  path: string,
  name: string,
  sheet: string | null = null,
  mime = '',
): Promise<ImportSource> {
  if (!path || !existsSync(path)) {
    // Name the path when there is one. A caller that handed over a path wants to
    // know WHICH path was not there; a caller that handed over a stored file has
    // no path to be told about, and its bytes simply are not on this disk.
    throw ingestError(
      'not_found',
      path
        ? `The import file’s bytes are not available at ${path}.`
        : 'The import file’s bytes are not available locally.',
    );
  }
  // Bound the read: a source reached by path (rather than through the upload cap)
  // can be any size at all, and streaming one whole into memory would take the
  // process down.
  const sizeBytes = statSync(path).size;
  if (sizeBytes > MAX_INGEST_BYTES) {
    throw ingestError(
      'too_large',
      `The import file is too large (${String(Math.round(sizeBytes / 1_000_000))} MB); ` +
        `the limit is ${String(Math.round(MAX_INGEST_BYTES / 1_000_000))} MB.`,
    );
  }
  // Every branch runs through applySourceNameFallback with the source's own
  // name — the SAME value the automatic importer uses on the upload door — so an
  // anonymous top-level key (Excel's default `Sheet1`, a JSON `table_1`) gets the
  // same file-derived name on both doors (doors parity), and the materialize
  // pre-flight never refuses a default-named workbook.
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
  // Documents: extract embedded tables (every row) so a .docx/.pptx materializes the
  // SAME way the automatic importer proposed it — without this, an import of a Word /
  // PowerPoint file fails here with "not valid JSON".
  // `name` doubles as the naming-ladder fallback label.
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
    throw ingestError('invalid_request', 'The import file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw ingestError('invalid_request', 'Expected a JSON object whose keys are record arrays.');
  }
  return {
    data: applySourceNameFallback(parsed as Record<string, unknown>, name),
    formulaSummary: null,
    importWarnings: [],
    name,
  };
}

/** Split a `<id>#<sheet>` reference into its parts. Re-exported for callers that
 *  hold a reference and need to know which sheet it names. */
export { parseSheetFileRef };

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
export function publishMarginalLinksNote(deps: ImportApplyDeps, count: number): void {
  if (count === 0) return;
  const summary =
    `Left ${String(count)} possible link${count === 1 ? '' : 's'} unconnected ` +
    `(low confidence) — connect from the Data Model panel if they belong.`;
  // A general import note, not a row mutation — table:null keeps it non-clickable, like the
  // other non-row signals on the feed.
  deps.feed.publish({ table: null, op: 'schema', rowId: null, source: 'system', summary });
}

/**
 * Write the import into the workspace's change log, once, whatever door it came
 * through — so an import is still there tomorrow, and not only as a live bubble
 * that scrolls away.
 *
 * The entry is deliberately HONEST about reversal rather than reassuring: an
 * import creates tables, declares them, and loads rows in bulk, and none of that
 * can be replayed backwards from recorded per-row inverses, so the entry says
 * plainly that it cannot be undone in one step and what to do instead (see
 * `recordImportActivity`). Asking to reverse it refuses in the same words.
 *
 * An import that made no table and wrote no row has nothing to record — that is a
 * no-op, not an event, and logging it would only add noise to the change log.
 */
async function recordImportInHistory(
  deps: ImportApplyDeps,
  sourceName: string,
  result: MaterializeResult,
): Promise<MaterializeResult> {
  if (result.tablesCreated.length === 0 && Object.keys(result.rowsByTable).length === 0) {
    return result;
  }
  await recordImportActivity(deps.db, deps.feed, {
    source: sourceName,
    tablesCreated: result.tablesCreated,
    rowsByTable: result.rowsByTable,
    asOf: result.asOf,
    asOfColumn: result.asOfColumn,
  });
  return result;
}

/**
 * Report the marginal (low-confidence) links of one materialized plan: count them, then publish
 * the activity note. Returns how many were reported (0 ⇒ nothing published).
 */
function reportMarginalLinks(deps: ImportApplyDeps, plan: ProposedSchema): number {
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
 * Returns an aggregate {@link MaterializeResult} so a caller's done handler reads it exactly
 * like a single-plan import.
 */
async function materializeWorkbookPerSheet(
  deps: ImportApplyDeps,
  jobs: SheetJob[],
  opts: {
    linkConfidence: number;
    asOf: string | null;
    asOfColumn: string | null;
    mode: ImportMode;
    emit: (p: ImportApplyEvent) => void;
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
      // so the aggregate result the caller's done handler reads reflects what really landed
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
  // be imported. The caller's done handler shows the real per-table totals; this line makes a
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

/**
 * Turn a source that has been read into tables, rows, and relationships in a
 * workspace — the whole apply, from records to a materialized model.
 *
 * Infers the schema, recognises the source as a new period of something already
 * held, splits a workbook too large for one plan into per-sheet units, creates
 * the computed tables the caller opted into, and reports the low-confidence links
 * it deliberately left unconnected. `onProgress` receives every line as it
 * happens; a caller that only wants the outcome can ignore it and read the
 * returned result.
 *
 * The date rule is the no-overwrite guarantee and it lives HERE, not in any one
 * caller, so every door gets it: an import carrying no date at all is stamped
 * with today's, making it a dated snapshot, so re-importing the same dataset
 * later APPENDS beside the earlier one instead of silently clobbering it.
 */
export async function applyImport(
  deps: ImportApplyDeps,
  source: ImportSource,
  options: ImportApplyOptions = {},
  onProgress: (event: ImportApplyEvent) => void = () => undefined,
): Promise<MaterializeResult> {
  const emit = onProgress;
  const { data, formulaSummary, importWarnings, name } = source;
  const mode: ImportMode = options.mode ?? 'both';
  const asOf = options.asOf ?? null;
  const asOfColumn = options.asOfColumn ?? null;
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
  // A caller echoes the threshold its proposal was inferred under, so the
  // re-derivation bands links the same way even if the preference changed
  // between reading and applying. Clamped; absent ⇒ the current preference.
  const linkConfidence =
    typeof options.linkConfidence === 'number' && Number.isFinite(options.linkConfidence)
      ? Math.min(1, Math.max(0, options.linkConfidence))
      : getClarifyThreshold();
  const computedSelection = options.computed ?? [];

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
    return recordImportInHistory(
      deps,
      name,
      await materializeWorkbookPerSheet(deps, workbookJobs, {
        linkConfidence,
        asOf: effectiveAsOf,
        asOfColumn,
        mode,
        emit,
      }),
    );
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
  // one import without an explicit override. A caller who reviewed the scope may proceed;
  // a silent import or a direct/assistant caller cannot blow the workspace up past the cap.
  const plannedTables =
    plan.entities.length +
    plan.dimensions.length +
    new Set(plan.linkages.map((l) => l.junction).filter(Boolean)).size;
  // A smaller multi-sheet workbook whose EXACT plan still exceeds the cap also splits per
  // sheet rather than dead-ending — the whole-workbook inference above was needed to learn
  // the exact count (a sheet count under the cap can still fan out past it via dimensions).
  if (workbookJobs.length > 1 && plannedTables > MAX_IMPORT_TABLES) {
    return recordImportInHistory(
      deps,
      name,
      await materializeWorkbookPerSheet(deps, workbookJobs, {
        linkConfidence,
        asOf: effectiveAsOf,
        asOfColumn,
        mode,
        emit,
      }),
    );
  }
  if (plannedTables > MAX_IMPORT_TABLES && options.override !== true) {
    throw ingestError(
      'invalid_request',
      `This import would create ${String(plannedTables)} tables, over the safe limit of ${String(MAX_IMPORT_TABLES)}. Review and confirm the import to proceed.`,
    );
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
  // Re-derive the proposals from the same inputs the read used and honor the
  // selection by NAME (a caller's payload is never trusted as a definition). A
  // computed-create failure is a warning — the import itself has already
  // succeeded and the raw columns are in.
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
      for (const fieldName of selection.fields) {
        const field = byField.get(fieldName);
        const def = field ? proposalToFieldDef(field) : null;
        if (!def) {
          emit({
            phase: 'computed',
            message: `Skipping unknown computed field "${selection.table}.${fieldName}"`,
          });
          continue;
        }
        fields[fieldName] = def;
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
  // unconnected is reported (feed event for the activity log + a line on this progress stream) so
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
  return recordImportInHistory(deps, name, result);
}
