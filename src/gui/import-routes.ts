import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lattice } from '../lattice.js';
import { sendJson, readJson } from './http.js';
import type { ImportMode } from '../import/materialize.js';
import { localPathOf } from './files-routes.js';
import { loadStoredFileLocation } from './file-row.js';
import { parseSheetFileRef } from '../import/sheet-jobs.js';
import { ingestError } from '../ops/ingest-errors.js';
import {
  applyImport,
  readImportSource,
  type ComputedSelection,
  type ImportApplyDeps,
  type ImportApplyEvent,
  type ImportSource,
} from '../ops/import-apply.js';

/**
 * Structured-source import — the HTTP adapter over the apply capability.
 *
 * The importer's browser door: `autoImportStructured` builds a proposal at
 * upload time and stamps it with the dropped file's `fileId` (its `files` row
 * id); this route materializes the proposal when the user confirms. It re-reads
 * the original bytes from the file's RETAINED blob (xlsx/json/csv are in the
 * retainable set) — there is no separate staging dir and no dashboard coupling.
 * Everything is RE-DERIVED server-side from those bytes (the upload's proposal is
 * display-only); the body's `linkConfidence` and `computed` selections are the
 * only client inputs beyond mode/date.
 *
 * The apply itself lives in `ops/import-apply.ts`, so a command, a job, or a
 * library caller imports a file without a server. What is left here is transport:
 * resolving which uploaded file the browser meant, and streaming the progress
 * lines back as NDJSON.
 *
 * POST /api/import/apply
 *   { fileId, mode, asOf, asOfColumn, linkConfidence?, computed? } → NDJSON.
 */

/** Context the import-apply route needs from the active workspace. */
export type ImportRouteDeps = ImportApplyDeps;

// The apply capability and its helpers live outside this HTTP adapter.
// Re-exported here so callers that predate the move keep working unchanged.
export {
  applyImport,
  readImportSource,
  existingDataTables,
  countMarginalLinks,
  publishMarginalLinksNote,
} from '../ops/import-apply.js';
export type { ImportSource, ImportApplyOptions, ComputedSelection } from '../ops/import-apply.js';

/**
 * Re-read a previously-uploaded structured file's records from its retained
 * blob, choosing the parser from the row's original_name / mime (the blob is
 * content-addressed and extensionless).
 *
 * This is the browser's addressing scheme — a `files` row id — resolved to a path
 * the capability can read. The local-bytes path a retained row points at is
 * resolved by the SHARED, hardened `localPathOf`: it gates a `local_ref` behind
 * the local-file-open floor (off on team cloud) and realpath-contains a
 * `blob_path` to the workspace root. Using the shared resolver keeps this read
 * sink from reaching another tenant's blob when a row's location columns are
 * forged (the same guard the blob route relies on).
 */
export async function readImportSourceFromFile(
  db: Lattice,
  fileRef: string,
  latticeRoot: string | undefined,
): Promise<ImportSource> {
  // A reference may name the whole file (a bare files-row id) or a single sheet of a
  // multi-sheet workbook (`<id>#<sheet>`), so one sheet can be re-read + applied on its own.
  const { fileId, sheet } = parseSheetFileRef(fileRef);
  const row = await loadStoredFileLocation(db, fileId);
  if (!row) throw ingestError('not_found', 'Unknown import file: ' + fileId);
  const path = localPathOf(row, latticeRoot);
  return readImportSource(path ?? '', row.original_name ?? '', sheet, row.mime ?? '');
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

export async function dispatchImportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImportRouteDeps,
): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  // @capability import.apply
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
  const linkConfidence =
    typeof body.linkConfidence === 'number' && Number.isFinite(body.linkConfidence)
      ? body.linkConfidence
      : undefined;
  const computed = readComputedSelection(body.computed);
  if (!fileId) {
    sendJson(res, { error: 'fileId is required' }, 400);
    return true;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  const emit = (p: ImportApplyEvent): void => {
    res.write(JSON.stringify(p) + '\n');
  };
  try {
    emit({ phase: 'parse', message: 'Reading source…' });
    const source = await readImportSourceFromFile(deps.db, fileId, deps.latticeRoot);
    const result = await applyImport(
      deps,
      source,
      {
        mode,
        asOf,
        asOfColumn,
        linkConfidence,
        computed,
        override: body.override === true,
      },
      emit,
    );
    emit({ phase: 'done', ok: true, result });
  } catch (e) {
    emit({ phase: 'error', message: (e as Error).message });
  }
  res.end();
  return true;
}
