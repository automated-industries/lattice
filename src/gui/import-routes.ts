import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import type { ComputedTableDef, ComputedFieldDef } from '../config/types.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { sendJson, readJson, MAX_INGEST_BYTES } from './http.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { materializeImport, type ImportMode } from '../import/materialize.js';
import { localPathOf } from './files-routes.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import {
  excelFormulaSummary,
  excelImportWarnings,
  excelToRecords,
  type WorkbookFormulaSummary,
} from '../import/excel.js';
import { csvToRecords } from '../import/csv.js';
import {
  buildComputedProposals,
  type ComputedFieldProposal,
} from '../import/computed-proposals.js';
import type { ProposedSchema } from '../import/types.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';
import { getClarifyThreshold } from './assistant-routes.js';
import type { FeedBus } from './feed.js';
import { enqueueQuestion } from './questions.js';

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
  /** Feed bus — marginal-link clarification questions are enqueued through it. */
  feed: FeedBus;
  /**
   * Creates a computed table through the audited GUI op (view DDL + YAML +
   * audit + AI fill). Absent ⇒ computed opt-ins are reported as skipped.
   */
  createComputed?: (name: string, def: ComputedTableDef) => Promise<void>;
}

/** At most this many marginal-link questions are enqueued per import. */
const MAX_LINK_QUESTIONS = 5;
/** The affirmative option — the deferred action runs only on this exact pick. */
const LINK_YES = 'Yes, connect them';
const LINK_NO = "No, it's just text";

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
  fileId: string,
  latticeRoot: string | undefined,
): Promise<{
  data: Record<string, unknown>;
  formulaSummary: WorkbookFormulaSummary | null;
  importWarnings: string[];
}> {
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
  if (/\.xlsx?$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel')) {
    const data = await excelToRecords(path);
    return {
      data,
      formulaSummary: excelFormulaSummary(path),
      importWarnings: excelImportWarnings(path),
    };
  }
  if (/\.(csv|tsv)$/i.test(name) || mime.includes('csv') || mime.includes('tab-separated')) {
    return { data: csvToRecords(path, name), formulaSummary: null, importWarnings: [] };
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
  return { data: parsed as Record<string, unknown>, formulaSummary: null, importWarnings: [] };
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
 * Enqueue clarification questions for the marginal links of a (renamed) plan:
 * highest confidence first, capped, and only for references that survived as
 * scalar columns on the materialized entity (an array reference has no column
 * a later "yes" could read). Answering "Yes, connect them" creates + fills the
 * junction via the deferred `import_link` action; a "No" or dismissal does
 * nothing; a free-form answer is persisted as the column's definition.
 */
async function enqueueMarginalLinkQuestions(
  deps: ImportRouteDeps,
  plan: ProposedSchema,
): Promise<number> {
  const marginal = [...plan.marginalLinks].sort((a, b) => b.confidence - a.confidence);
  let asked = 0;
  for (const link of marginal) {
    if (asked >= MAX_LINK_QUESTIONS) break;
    const from = plan.entities.find((e) => e.name === link.fromEntity);
    const column = from?.columns.find((c) => c.sourceKey === link.fromField);
    if (!from || !column) continue; // reference did not survive as a scalar column
    await enqueueQuestion(deps.db, deps.feed, {
      source: 'import',
      question: `Is "${link.fromField}" in ${link.fromEntity} meant to refer to your ${link.toEntity} records?`,
      options: [LINK_YES, LINK_NO],
      context: {
        action: {
          kind: 'import_link',
          confirm: LINK_YES,
          junction: link.junction ?? `${link.fromEntity}_${link.toEntity}`,
          fromTable: link.fromEntity,
          fromColumn: column.name,
          toTable: link.toEntity,
          toKey: link.toKey,
        },
        enrich: [{ target: 'column_definition', table: link.fromEntity, column: column.name }],
      },
    });
    asked++;
  }
  return asked;
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
  }>(req).catch(() => ({}) as Record<string, unknown>);
  const fileId = typeof body.fileId === 'string' ? body.fileId : '';
  const mode: ImportMode = body.mode === 'schema' || body.mode === 'contents' ? body.mode : 'both';
  const asOf =
    typeof body.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf.trim())
      ? body.asOf.trim()
      : null;
  const asOfColumn =
    typeof body.asOfColumn === 'string' && body.asOfColumn.trim() ? body.asOfColumn.trim() : null;
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
    const { data, formulaSummary, importWarnings } = await readImportSourceFromFile(
      deps.db,
      fileId,
      deps.latticeRoot,
    );
    // Surface a stacked-table partial-import warning on the apply log — a partial import is
    // never silent (it also rode the confirm card + the post-import feed pill).
    for (const w of importWarnings) emit({ phase: 'warning', message: w });
    emit({ phase: 'infer', message: 'Analyzing schema…' });
    const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
      inferSchema(data, { minLinkConfidence: linkConfidence }),
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
    }
    const result = await materializeImport(
      { db: deps.db, configPath: deps.configPath },
      data,
      plan,
      views,
      {
        mode,
        asOf,
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

    // ── Marginal links → clarification questions ──
    // Confidently-inferred links were materialized above; the marginal band
    // asks instead of guessing.
    const asked = await enqueueMarginalLinkQuestions(deps, plan);
    if (asked > 0) {
      emit({
        phase: 'questions',
        count: asked,
        message: `Queued ${String(asked)} question${asked === 1 ? '' : 's'} about possible links — answer in the assistant panel.`,
      });
    }

    emit({ phase: 'done', ok: true, result });
  } catch (e) {
    emit({ phase: 'error', message: (e as Error).message });
  }
  res.end();
  return true;
}
