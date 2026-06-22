import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Lattice } from '../lattice.js';
import { getAsyncOrSync } from '../db/adapter.js';
import { sendJson, readJson } from './http.js';
import { inferSchema } from '../import/infer.js';
import { dedupeAndDetectViews } from '../import/dedupe-views.js';
import { materializeImport, type ImportMode } from '../import/materialize.js';
import { matchSchemaToExisting, renameEntities, type ExistingTable } from '../import/match.js';
import { excelToRecords } from '../import/excel.js';
import { NATIVE_ENTITY_NAMES } from '../framework/native-entities.js';

/**
 * Structured-source import — apply route. The importer is reachable only by
 * dropping a file in the assistant chat: `autoImportStructured` builds the
 * proposal at upload time and stamps it with the dropped file's `fileId` (its
 * `files` row id); this route materializes the proposal when the user confirms.
 * It re-reads the original bytes from the file's RETAINED blob (xlsx/json/csv are
 * in the retainable set) — there is no separate staging dir and no dashboard
 * coupling. POST /api/import/apply { fileId, mode, asOf, asOfColumn } → NDJSON.
 */

/** Context the import-apply route needs from the active workspace. */
export interface ImportRouteDeps {
  db: Lattice;
  configPath: string;
  latticeRoot: string | undefined;
  validTables: Set<string>;
  softDeletable: Set<string>;
}

interface FileRow {
  id: string;
  original_name?: string | null;
  mime_type?: string | null;
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

/** The local bytes path a retained files row points at (a `local_ref` or an
 *  on-disk content-addressed blob). Mirrors files-routes' resolution. */
function localPathOf(row: FileRow, latticeRoot: string | undefined): string | null {
  if (row.ref_kind === 'local_ref' && row.ref_uri) return row.ref_uri;
  if ((row.ref_kind === 'blob' || row.ref_kind === 'cloud_ref') && row.blob_path) {
    return isAbsolute(row.blob_path)
      ? row.blob_path
      : latticeRoot
        ? join(latticeRoot, row.blob_path)
        : null;
  }
  return null;
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
 * Re-read a previously-uploaded structured file's records from its retained
 * blob, choosing the parser from the row's original_name / mime (the blob is
 * content-addressed and extensionless). Throws a 400-mapped error if the row is
 * gone or its bytes aren't on this disk.
 */
async function readImportSourceFromFile(
  db: Lattice,
  fileId: string,
  latticeRoot: string | undefined,
): Promise<Record<string, unknown>> {
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "id","original_name","mime_type","ref_kind","ref_uri","blob_path"
       FROM "files" WHERE "id" = ? AND "deleted_at" IS NULL LIMIT 1`,
    [fileId],
  )) as FileRow | undefined;
  if (!row) throw badRequest('Unknown import file: ' + fileId);
  const path = localPathOf(row, latticeRoot);
  if (!path || !existsSync(path)) {
    throw badRequest('The import file’s bytes are not available locally.');
  }
  const name = row.original_name ?? '';
  const mime = row.mime_type ?? '';
  if (/\.xlsx?$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel')) {
    return excelToRecords(path);
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
  return parsed as Record<string, unknown>;
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
  }>(req).catch(() => ({}) as Record<string, unknown>);
  const fileId = typeof body.fileId === 'string' ? body.fileId : '';
  const mode: ImportMode = body.mode === 'schema' || body.mode === 'contents' ? body.mode : 'both';
  const asOf =
    typeof body.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf.trim())
      ? body.asOf.trim()
      : null;
  const asOfColumn =
    typeof body.asOfColumn === 'string' && body.asOfColumn.trim() ? body.asOfColumn.trim() : null;
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
    const data = await readImportSourceFromFile(deps.db, fileId, deps.latticeRoot);
    emit({ phase: 'infer', message: 'Analyzing schema…' });
    const { plan: inferredPlan, views: inferredViews } = dedupeAndDetectViews(
      inferSchema(data),
      data,
    );
    emit({
      phase: 'infer',
      message: `Found ${String(inferredPlan.entities.length)} entities, ${String(inferredPlan.dimensions.length)} dimensions, ${String(inferredPlan.linkages.length)} links`,
    });
    const match = matchSchemaToExisting(existingDataTables(deps.db), inferredPlan);
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
    emit({ phase: 'done', ok: true, result });
  } catch (e) {
    emit({ phase: 'error', message: (e as Error).message });
  }
  res.end();
  return true;
}
