import { createHash } from 'node:crypto';
import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import type { FeedBus } from './feed.js';
import { deleteRow, linkRows, unlinkRows, type MutationCtx } from './mutations.js';
import { findDuplicateGroups, type DedupItem, type DedupGroup } from '../dedup/index.js';
import { keyFromColumns, normalizeText } from '../dedup/normalize.js';
import { DEFAULT_NEAR_THRESHOLD } from '../dedup/match.js';
import { tableJunctions } from './data.js';

/**
 * Row de-duplication as a SERVICE (no HTTP, no presentation) — used by the
 * non-blocking ingest auto-dedup pass and the assistant's `dedup` tool. Merges
 * are attributed to `source:'system'` ("Lattice"), re-point many-to-many links
 * onto the survivor, and soft-delete the duplicates (recoverable from Trash /
 * Undo). Replaces PR #54's GUI dedup surface, which we did not bring forward.
 */
export interface DedupServiceCtx {
  db: Lattice;
  feed: FeedBus;
  softDeletable: Set<string>;
  configPath: string;
  outputDir: string;
  sessionId?: string | undefined;
}

const get = (r: Row, k: string): unknown => (r as Record<string, unknown>)[k];
/** A row cell coerced to a string ('' when absent / non-string). */
const cellStr = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A row cell coerced to a non-empty string, or null (DedupItem.createdAt shape). */
const cellStrOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** Up to two free-text key columns to group a generic table by (skips ids/system). */
function defaultKeyColumns(cols: string[]): string[] {
  const skip = /^(id|.*_id|.*_at|deleted_at)$/;
  const pref = ['name', 'title', 'slug', 'email', 'label'];
  const chosen = pref.filter((p) => cols.includes(p));
  if (chosen.length > 0) return chosen.slice(0, 2);
  return cols.filter((c) => !skip.test(c)).slice(0, 2);
}

/**
 * Content-duplicate groups for the `files` entity: byte-identical first (sha256),
 * then identical extracted text, then — when `fuzzy` — near-identical extracted
 * text. Groups are disjoint (a row grouped by sha isn't re-grouped by text).
 */
function fileContentGroups(rows: Row[], fuzzy: boolean, threshold?: number): DedupGroup[] {
  const shaItems: DedupItem[] = rows
    .filter((r) => get(r, 'sha256'))
    .map((r) => ({
      id: String(get(r, 'id')),
      key: 'sha:' + String(get(r, 'sha256')),
      createdAt: cellStrOrNull(get(r, 'created_at')),
    }));
  const shaGroups = findDuplicateGroups(shaItems, { fuzzy: false });
  const grouped = new Set<string>();
  shaGroups.forEach((g) => {
    g.ids.forEach((id) => grouped.add(id));
  });

  const txtItems: DedupItem[] = rows
    .filter((r) => {
      if (grouped.has(String(get(r, 'id')))) return false;
      const t = get(r, 'extracted_text');
      return typeof t === 'string' && t.trim().length > 0;
    })
    .map((r) => {
      const norm = normalizeText(get(r, 'extracted_text'));
      // Fuzzy compares keys directly (bounded slice keeps it cheap); exact hashes.
      const key = fuzzy
        ? 'txt:' + norm.slice(0, 2000)
        : 'txt:' + createHash('sha256').update(norm).digest('hex');
      return { id: String(get(r, 'id')), key, createdAt: cellStrOrNull(get(r, 'created_at')) };
    });
  const txtGroups = findDuplicateGroups(txtItems, {
    fuzzy,
    ...(threshold !== undefined ? { threshold } : {}),
  });
  return [...shaGroups, ...txtGroups];
}

/**
 * Find duplicate groups in `table`. `files` groups by content (sha → text →
 * fuzzy text); any other table groups by its key columns. This loads the table
 * — it is an EXPLICIT operation (the assistant `dedup` tool), not a hot path.
 */
export async function findTableDuplicates(
  ctx: DedupServiceCtx,
  table: string,
  opts: { fuzzy?: boolean; threshold?: number; keyColumns?: string[] } = {},
): Promise<DedupGroup[]> {
  const rows = (await ctx.db.query(table, {})).filter((r) => !get(r, 'deleted_at'));
  if (table === 'files') return fileContentGroups(rows, opts.fuzzy ?? false, opts.threshold);
  const cols = ctx.db.getRegisteredColumns(table);
  const keyCols = opts.keyColumns ?? defaultKeyColumns(cols ? Object.keys(cols) : []);
  if (keyCols.length === 0) return [];
  const items: DedupItem[] = rows
    .map((r) => ({
      id: String(get(r, 'id')),
      key: keyFromColumns(r as Record<string, unknown>, keyCols),
      createdAt: cellStrOrNull(get(r, 'created_at')),
    }))
    .filter((it) => it.key.length > 0);
  return findDuplicateGroups(items, {
    fuzzy: opts.fuzzy ?? false,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  });
}

/**
 * BOUNDED check for files byte-identical to a just-inserted row — a `sha256 =`
 * filter query, NOT a full-table scan (internal guideline). Returns the OTHER files that
 * share the row's sha256 (active only). Used by the non-blocking ingest pass;
 * near-duplicate/fuzzy detection is left to the explicit `dedup` tool.
 */
export async function findExactFileDupesOf(
  ctx: DedupServiceCtx,
  row: { id: string; sha256?: unknown },
): Promise<string[]> {
  const sha = cellStr(row.sha256);
  if (!sha) return [];
  const selfId = row.id;
  const matches = await ctx.db.query('files', {
    filters: [{ col: 'sha256', op: 'eq', val: sha }],
  });
  return matches
    .filter((r) => !get(r, 'deleted_at') && String(get(r, 'id')) !== selfId)
    .sort((a, b) => cellStr(get(a, 'created_at')).localeCompare(cellStr(get(b, 'created_at'))))
    .map((r) => String(get(r, 'id'))); // oldest first → caller keeps [0] as survivor
}

/** One source-side junction edge to re-point onto the survivor. */
interface SourceEdge {
  junction: string;
  selfFk: string;
  otherFk: string;
  sid: unknown;
  otherId: unknown;
}

/**
 * Merge duplicates onto a survivor: re-point every many-to-many link from each
 * source onto the survivor, then soft-delete the sources. Attributed to
 * `source:'system'`.
 *
 * CRASH-SAFETY INVARIANT (ordered phases, NOT a transactional rollback). A true
 * DB transaction is not cleanly available here — each mutation goes through the
 * adapter plus changelog/render/audit hooks and does not compose into one tx — so
 * safety comes from ORDERING the writes so the dangerous middle state never
 * exists. The work runs in three strict phases:
 *   1. LINK ALL — for every `(source, other)` edge gathered across all sources,
 *      link `(survivor, other)` only. link is insert-or-ignore (additive +
 *      idempotent), so nothing is removed. A crash here leaves the originals
 *      intact and the survivor merely OVER-LINKED — a harmless superset that
 *      re-running completes.
 *   2. UNLINK ALL — only after every survivor link is in place, drop each
 *      source's recorded edge.
 *   3. DELETE ALL — only after every source edge is dropped, soft-delete the
 *      sources.
 * Because links are written to the survivor BEFORE any source edge or row is
 * removed, a crash at any point leaves a consistent, re-runnable state — never a
 * half-merge where a source edge is gone but the survivor's copy never landed.
 * The success-path end state and the returned `{ merged, relinked }` are
 * byte-identical to a single interleaved pass.
 */
export async function mergeDuplicates(
  ctx: DedupServiceCtx,
  table: string,
  survivorId: string,
  sourceIds: string[],
): Promise<{ merged: number; relinked: number }> {
  const ids = sourceIds.filter((id) => id && id !== survivorId);
  if (ids.length === 0) return { merged: 0, relinked: 0 };
  const mctx: MutationCtx = {
    db: ctx.db,
    feed: ctx.feed,
    softDeletable: ctx.softDeletable,
    source: 'system',
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
  const junctions = tableJunctions(table, ctx.configPath, ctx.outputDir);
  let relinked = 0;
  let phase: 'link' | 'unlink' | 'delete' = 'link';
  try {
    // PHASE 1 — LINK ALL (additive, idempotent). Gather every source edge with
    // the same bounded `IN (...)` query per junction, write the survivor's copy,
    // and record the source edge for phase 2. Nothing is removed in this phase,
    // so a crash leaves the originals intact + the survivor over-linked.
    const sourceEdges: SourceEdge[] = [];
    for (const j of junctions) {
      // ONE bounded query per junction for ALL sources (an `IN (...)` filter), not
      // one query per (junction, source) pair — keeps the relink off the N+1 path
      // even when a merged file carries many cross-links (internal guideline).
      const links = await ctx.db.query(j.junction, {
        filters: [{ col: j.selfFk, op: 'in', val: ids }],
      });
      for (const link of links) {
        const rec = link as Record<string, unknown>;
        const sid = rec[j.selfFk];
        const otherId = rec[j.otherFk];
        if (otherId == null || sid == null) continue;
        await linkRows(mctx, j.junction, { [j.selfFk]: survivorId, [j.otherFk]: otherId } as Row);
        sourceEdges.push({
          junction: j.junction,
          selfFk: j.selfFk,
          otherFk: j.otherFk,
          sid,
          otherId,
        });
        relinked++;
      }
    }
    // PHASE 2 — UNLINK ALL the source edges (only after every link is in place).
    phase = 'unlink';
    for (const e of sourceEdges) {
      await unlinkRows(mctx, e.junction, { [e.selfFk]: e.sid, [e.otherFk]: e.otherId } as Row);
    }
    // PHASE 3 — DELETE ALL the source rows (last, after every edge is moved).
    phase = 'delete';
    for (const sid of ids) await deleteRow(mctx, table, sid, false);
  } catch (cause) {
    // Fail loudly — never swallow. Re-throw with which phase failed and the rows
    // in flight. The ordering guarantees re-running completes the merge from
    // wherever it stopped: phase 1 links are idempotent, phase 2 unlinks of an
    // already-gone edge are no-ops, phase 3 re-soft-deletes are no-ops.
    throw new Error(
      `dedup mergeDuplicates failed mid-merge (phase=${phase}); survivor=${survivorId} sources=${ids.join(',')} table=${table}; safe to re-run`,
      { cause },
    );
  }
  return { merged: ids.length, relinked };
}

/**
 * Aggressiveness (0..1) → near-duplicate similarity threshold. Higher
 * aggressiveness ⇒ lower threshold ⇒ more liberal fuzzy merging. Clamped so even
 * max aggressiveness stays at a sane floor (0.82) and min stays near-exact (~0.98).
 */
export function aggressivenessToThreshold(aggr: number): number {
  const t = 1 - 0.18 * Math.max(0, Math.min(1, aggr));
  return Math.max(DEFAULT_NEAR_THRESHOLD, Math.min(0.98, t));
}
