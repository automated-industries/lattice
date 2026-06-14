import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { FeedBus } from './feed.js';
import { sendJson, readJson } from './http.js';
import { tableJunctions, type TableJunction } from './data.js';
import { deleteRow, linkRows, unlinkRows, type MutationCtx } from './mutations.js';
import { findDuplicateGroups, type DedupItem, type DedupGroup } from '../dedup/index.js';
import { keyFromColumns, normalizeText } from '../dedup/normalize.js';

/**
 * Row de-duplication routes (`/api/dedup/*`). Generic + deterministic — exact
 * grouping after text normalization, optional Sørensen–Dice fuzzy near-dupes, and
 * a CONTENT mode for the `files` entity that groups by byte hash (sha256) then by
 * extracted-text hash so renamed re-downloads ("file (1)", "file (2)") collapse.
 *
 * Merge re-points many-to-many links onto the survivor (via the shared
 * link/unlink mutation chokepoints, so it's audited) and soft-deletes the
 * duplicates — never raw SQL, never a hard delete on a soft-deletable table.
 */

export interface DedupRouteCtx {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  validTables: Set<string>;
  junctionTables: Set<string>;
  configPath: string;
  outputDir: string;
  sessionId?: string | undefined;
  pathname: string;
  method: string;
}

/** Cap rows scanned per find so a huge table can't stall the request. */
const ROW_CAP = 5000;

const SYSTEM_COL = /^(id|uuid|created_at|updated_at|deleted_at)$/;

/** Columns a user can sensibly group on: text-ish, non-system, non-foreign-key. */
function selectableColumns(db: Lattice, table: string): string[] {
  const cols = (db.getRegisteredColumns(table) ?? {}) as Record<string, unknown>;
  return Object.keys(cols).filter((c) => {
    if (SYSTEM_COL.test(c)) return false;
    if (c.endsWith('_id') || c.endsWith('_at')) return false;
    const type = String(cols[c] ?? '').toUpperCase();
    // Empty type spec (untyped/native) is included; otherwise keep text-like only.
    return type === '' || /TEXT|CHAR|VARCHAR|CLOB/.test(type);
  });
}

/** Default grouping column for a non-files table: a common label column, else the first selectable. */
function defaultKeyColumns(cols: string[]): string[] {
  for (const p of ['name', 'title', 'label', 'original_name', 'subject', 'email']) {
    if (cols.includes(p)) return [p];
  }
  return cols.length ? [cols[0]!] : [];
}

/** Human-readable label for a row in the review list. */
function rowLabel(row: Row): string {
  const r = row as Record<string, unknown>;
  const pick = r.name ?? r.title ?? r.label ?? r.original_name ?? r.subject;
  if (pick != null && String(pick).trim()) return String(pick);
  return 'row ' + String(r.id ?? '').slice(0, 8);
}

function formatBytes(n: unknown): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Content-based grouping for `files`: Tier 1 byte hash, then Tier 2 text hash. */
function fileContentGroups(rows: Row[]): DedupGroup[] {
  const get = (r: Row, k: string): unknown => (r as Record<string, unknown>)[k];

  const shaItems: DedupItem[] = rows
    .filter((r) => get(r, 'sha256'))
    .map((r) => ({
      id: String(get(r, 'id')),
      key: 'sha:' + String(get(r, 'sha256')),
      createdAt: (get(r, 'created_at') as string) ?? null,
    }));
  const shaGroups = findDuplicateGroups(shaItems, { fuzzy: false });

  const grouped = new Set<string>();
  shaGroups.forEach((g) => g.ids.forEach((id) => grouped.add(id)));

  const txtItems: DedupItem[] = rows
    .filter((r) => {
      if (grouped.has(String(get(r, 'id')))) return false;
      const t = get(r, 'extracted_text');
      return typeof t === 'string' && t.trim().length > 0;
    })
    .map((r) => ({
      id: String(get(r, 'id')),
      key: 'txt:' + createHash('sha256').update(normalizeText(get(r, 'extracted_text'))).digest('hex'),
      createdAt: (get(r, 'created_at') as string) ?? null,
    }));
  const txtGroups = findDuplicateGroups(txtItems, { fuzzy: false });

  return [...shaGroups, ...txtGroups];
}

/** Count many-to-many links per row id, across every junction referencing `table`. */
async function linkCounts(
  db: Lattice,
  junctions: TableJunction[],
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  for (const j of junctions) {
    const links = (await db.query(j.junction, {
      filters: [{ col: j.selfFk, op: 'in', val: ids }],
    })) as Row[];
    for (const link of links) {
      const k = String((link as Record<string, unknown>)[j.selfFk]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

async function handleFind(req: IncomingMessage, res: ServerResponse, ctx: DedupRouteCtx): Promise<void> {
  const body = (await readJson(req)) as {
    table?: string;
    keyColumns?: string[];
    fuzzy?: boolean;
    mode?: string;
  };
  const table = body.table ?? '';
  if (!ctx.validTables.has(table) || ctx.junctionTables.has(table)) {
    sendJson(res, { error: `Cannot de-duplicate table: ${table}` }, 400);
    return;
  }

  const isFiles = table === 'files';
  const mode = body.mode ?? (isFiles && !(body.keyColumns && body.keyColumns.length) ? 'content' : 'columns');
  const selectable = selectableColumns(ctx.db, table);

  // Fetch live (non-deleted) rows, capped.
  const queryOpts: Parameters<typeof ctx.db.query>[1] = { limit: ROW_CAP };
  if (ctx.softDeletable.has(table)) queryOpts.filters = [{ col: 'deleted_at', op: 'isNull' }];
  const rows = (await ctx.db.query(table, queryOpts)) as Row[];
  const truncated = rows.length >= ROW_CAP;

  let groups: DedupGroup[];
  let keyColumns: string[] = [];
  if (mode === 'content') {
    groups = fileContentGroups(rows);
  } else {
    keyColumns = body.keyColumns && body.keyColumns.length ? body.keyColumns : defaultKeyColumns(selectable);
    if (!keyColumns.length) {
      sendJson(res, { error: 'No groupable columns on this table' }, 400);
      return;
    }
    const items: DedupItem[] = rows.map((r) => ({
      id: String((r as Record<string, unknown>).id),
      key: keyFromColumns(r as Record<string, unknown>, keyColumns),
      createdAt: ((r as Record<string, unknown>).created_at as string) ?? null,
    }));
    groups = findDuplicateGroups(items, { fuzzy: !!body.fuzzy });
  }

  // Enrich candidates with labels + link counts (only for rows that are in a group).
  const rowById = new Map<string, Row>(rows.map((r) => [String((r as Record<string, unknown>).id), r]));
  const allIds = groups.flatMap((g) => g.ids);
  const junctions = tableJunctions(table, ctx.configPath, ctx.outputDir);
  const counts = await linkCounts(ctx.db, junctions, allIds);

  const outGroups = groups.map((g) => ({
    kind: g.kind,
    score: g.score,
    candidates: g.ids
      .map((id) => {
        const row = rowById.get(id);
        if (!row) return null;
        const r = row as Record<string, unknown>;
        return {
          id,
          label: isFiles ? String(r.original_name ?? rowLabel(row)) : rowLabel(row),
          sub: isFiles ? formatBytes(r.size_bytes) : '',
          createdAt: (r.created_at as string) ?? null,
          linkCount: counts.get(id) ?? 0,
        };
      })
      .filter(Boolean),
  }));

  sendJson(res, {
    table,
    mode,
    keyColumns,
    fuzzy: !!body.fuzzy,
    columns: selectable,
    truncated,
    groups: outGroups,
  });
}

async function handleMerge(req: IncomingMessage, res: ServerResponse, ctx: DedupRouteCtx): Promise<void> {
  const body = (await readJson(req)) as { table?: string; survivorId?: string; sourceIds?: string[] };
  const table = body.table ?? '';
  const survivorId = body.survivorId ?? '';
  const sourceIds = (body.sourceIds ?? []).filter((id) => id && id !== survivorId);
  if (!ctx.validTables.has(table) || ctx.junctionTables.has(table)) {
    sendJson(res, { error: `Cannot de-duplicate table: ${table}` }, 400);
    return;
  }
  if (!survivorId || !sourceIds.length) {
    sendJson(res, { error: 'survivorId and a non-empty sourceIds[] are required' }, 400);
    return;
  }
  const survivor = await ctx.db.get(table, survivorId);
  if (!survivor) {
    sendJson(res, { error: `Survivor row not found: ${survivorId}` }, 400);
    return;
  }

  // The link/unlink/soft-delete here are performed automatically by Lattice's
  // de-duplication, not hand-edited by the user — attribute them to the system
  // ("Lattice") in the activity feed, not to the person who clicked the button.
  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'system',
    sessionId: ctx.sessionId,
  };
  const junctions = tableJunctions(table, ctx.configPath, ctx.outputDir);

  // 1. Re-point each duplicate's many-to-many links onto the survivor (union —
  //    link() is INSERT-OR-IGNORE so re-linking an existing edge is a no-op),
  //    then drop the duplicate's edge. No dangling references result.
  let relinked = 0;
  for (const j of junctions) {
    for (const sid of sourceIds) {
      const links = (await ctx.db.query(j.junction, {
        filters: [{ col: j.selfFk, op: 'eq', val: sid }],
      })) as Row[];
      for (const link of links) {
        const otherId = (link as Record<string, unknown>)[j.otherFk];
        if (otherId == null) continue;
        await linkRows(mctx, j.junction, { [j.selfFk]: survivorId, [j.otherFk]: otherId } as Row);
        await unlinkRows(mctx, j.junction, { [j.selfFk]: sid, [j.otherFk]: otherId } as Row);
        relinked++;
      }
    }
  }

  // 2. Soft-delete the duplicates (recoverable from Trash + the Undo restore).
  for (const sid of sourceIds) {
    await deleteRow(mctx, table, sid, false);
  }

  sendJson(res, { ok: true, survivorId, merged: sourceIds.length, relinked, sourceIds });
}

export async function dispatchDedupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DedupRouteCtx,
): Promise<boolean> {
  if (ctx.method !== 'POST') {
    sendJson(res, { error: `Method ${ctx.method} not allowed` }, 405);
    return true;
  }
  try {
    if (ctx.pathname === '/api/dedup/find') {
      await handleFind(req, res, ctx);
      return true;
    }
    if (ctx.pathname === '/api/dedup/merge') {
      await handleMerge(req, res, ctx);
      return true;
    }
  } catch (err) {
    sendJson(res, { error: (err as Error).message }, 500);
    return true;
  }
  return false;
}
