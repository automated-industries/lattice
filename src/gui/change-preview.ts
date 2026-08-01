import type { Lattice } from '../lattice.js';
import type { Row } from '../types.js';
import { MAX_ROWS_PAGE } from '../ops/paging.js';

/**
 * Change preview — the shared "what would change" computation.
 *
 * One module computes the field-level effect of a proposed row change for BOTH
 * the execution paths (updateRow's write-landed guard, bulk_update's target
 * selection) and the read-only preview route, so a preview can never drift from
 * what execution then does: they are the same functions.
 *
 * Layering: this is a runtime leaf. It imports only types plus the pure paging
 * limits, so `mutations.ts` and the AI tool handlers can both import from here
 * without a cycle. Nothing here writes — the preview engine issues bounded
 * SELECTs only.
 */

/** Operators a bulk `filter` clause may use (the `db.query` filter set). */
const BULK_FILTER_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'in',
  'isNull',
  'isNotNull',
]);

/**
 * Validate + normalize a bulk `filter` arg into the {col, op, val} shape
 * `db.query` accepts. Strict: an unknown column or op is a recoverable input
 * error (so the caller can correct it), NEVER a silently-wrong match that would
 * touch the wrong rows. `undefined`/omitted → no clauses → matches every row
 * (by design).
 *
 * (Moved here from the AI row-mutation handler so the preview route and the
 * bulk_update tool validate filters through the same code; the handler
 * re-exports it for its existing importers.)
 */
export function parseBulkFilters(
  raw: unknown,
  table: string,
  db: Lattice,
): { col: string; op: string; val?: unknown }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('filter must be an array of {col, op, val} clauses');
  const cols = db.getRegisteredColumns(table) ?? {};
  const out: { col: string; op: string; val?: unknown }[] = [];
  for (const clause of raw) {
    if (!clause || typeof clause !== 'object') {
      throw new Error('each filter clause must be an object {col, op, val}');
    }
    const c = clause as { col?: unknown; op?: unknown; val?: unknown };
    // `c.col in cols` is not "is this a column": every plain object inherits
    // `constructor`, `toString`, `hasOwnProperty` and the rest, so all of them passed
    // validation and were handed to the query builder as real column names.
    if (typeof c.col !== 'string' || !Object.prototype.hasOwnProperty.call(cols, c.col)) {
      throw new Error(`filter references unknown column "${String(c.col)}" on "${table}"`);
    }
    if (typeof c.op !== 'string' || !BULK_FILTER_OPS.has(c.op)) {
      throw new Error(`filter has invalid op "${String(c.op)}"`);
    }
    const needsVal = c.op !== 'isNull' && c.op !== 'isNotNull';
    if (needsVal && !('val' in c)) throw new Error(`filter op "${c.op}" requires a val`);
    out.push(needsVal ? { col: c.col, op: c.op, val: c.val } : { col: c.col, op: c.op });
  }
  return out;
}

/**
 * True when a stored cell value already equals a requested (JSON) value,
 * tolerating the type coercion the DB applies (boolean ↔ 0/1, number ↔ numeric
 * string, null ↔ ''). Decides whether an edit actually requests a change — used
 * by updateRow's write-landed guard, the group-undo conflict check, and the
 * per-field preview deltas, so all three agree on what counts as a change.
 */
export function storedValueMatches(stored: unknown, requested: unknown): boolean {
  if (stored === requested) return true;
  const storedEmpty = stored === null || stored === undefined || stored === '';
  const reqEmpty = requested === null || requested === undefined || requested === '';
  if (storedEmpty && reqEmpty) return true;
  if (typeof requested === 'boolean') return Number(stored) === Number(requested);
  if (typeof requested === 'number') return Number(stored) === requested;
  return String(stored) === String(requested);
}

/** One field of a proposed change: the stored value, the requested value, and
 *  whether applying the request would actually alter the row. */
export interface FieldDelta {
  column: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

/**
 * Per-field deltas of applying `values` to `before` — THE "what would change"
 * computation. updateRow derives its write-landed guard from this exact
 * function (`some(d => d.changed)`), and the preview engine serves it per row,
 * so a previewed no-op is precisely the no-op execution recognizes.
 *
 * `before` is normalized to null for a column the row lacks (e.g. a field the
 * write would auto-create) so the delta serializes stably over JSON; the
 * `changed` decision is unaffected (missing and null are both "empty" to
 * {@link storedValueMatches}).
 */
export function rowFieldDeltas(before: Row, values: Partial<Row>): FieldDelta[] {
  return Object.keys(values).map((column) => {
    const stored = before[column];
    const requested = (values as Row)[column];
    return {
      column,
      before: stored === undefined ? null : stored,
      after: requested === undefined ? null : requested,
      changed: !storedValueMatches(stored, requested),
    };
  });
}

/** The row-selection spec a bulk change targets: validated filters plus the
 *  primary-key column the iteration orders by. */
export interface BulkSelection {
  pkCol: string;
  filters: { col: string; op: string; val?: unknown }[];
}

/**
 * Build the target selection for a bulk change: validated filter clauses, the
 * never-touch-trashed-rows guard for soft-deletable tables, and the pk ordering
 * column. Shared by the bulk_update execution handler and the preview engine so
 * both resolve the same row set from the same description.
 */
export function bulkSelection(
  db: Lattice,
  table: string,
  rawFilter: unknown,
  softDeletable: ReadonlySet<string>,
): BulkSelection {
  const filters = parseBulkFilters(rawFilter, table, db);
  // Never silently include trashed rows in a bulk change.
  if (softDeletable.has(table)) filters.push({ col: 'deleted_at', op: 'isNull' });
  const pkCol = db.getPrimaryKey(table)[0] ?? 'id';
  return { pkCol, filters };
}

/** Default preview page size (a preview is a human-readable list, not a dump). */
export const PREVIEW_DEFAULT_LIMIT = 100;

/** How a preview names its target rows: an explicit id set, or a filter. */
export interface ChangePreviewOptions {
  /** Explicit row ids (the update_row / merge shape). Mutually exclusive with `filter`. */
  ids?: readonly string[];
  /** Bulk filter clauses (the bulk_update shape). Mutually exclusive with `ids`. */
  filter?: unknown;
  /** Page size, clamped to [1, MAX_ROWS_PAGE]. Default {@link PREVIEW_DEFAULT_LIMIT}. */
  limit?: number;
  /** Page start, floored at 0. */
  offset?: number;
}

/** One affected row in a preview: its id and the per-field deltas. */
export interface RowChangePreview {
  id: string;
  wouldChange: boolean;
  fields: FieldDelta[];
}

/** A bounded page of a change preview plus the (bounded) total match count. */
export interface ChangePreview {
  table: string;
  rows: RowChangePreview[];
  /** Matching rows in total — exact up to MAX_ROWS_PAGE, else MAX_ROWS_PAGE + 1. */
  total: number;
  /** True when `total` hit the count cap (render as "1000+"). */
  totalIsCapped: boolean;
  limit: number;
  offset: number;
  /** Columns in `set` the table does not have yet (execution would create them). */
  newColumns: string[];
}

/**
 * Compute a bounded, paginated preview of applying `set` to the described rows.
 *
 * Read-only: issues one page-sized SELECT plus one bounded COUNT — never a
 * whole-table scan, regardless of how many rows the description matches.
 * `readRelation` is the relation the SELECT targets: the base table locally,
 * or the audience-masking view on a scoped cloud connection, so a cell the
 * viewer cannot read never even reaches this process (the serve path
 * additionally masks — see {@link maskPreviewFields}).
 *
 * Row selection and per-field deltas go through {@link bulkSelection} and
 * {@link rowFieldDeltas} — the same functions the execution paths use — so the
 * preview and the subsequent execution cannot disagree. Ids that resolve to no
 * visible row are simply absent (a row that cannot be read cannot be changed).
 */
export async function previewRowChanges(
  db: Lattice,
  table: string,
  readRelation: string,
  softDeletable: ReadonlySet<string>,
  set: Record<string, unknown>,
  opts: ChangePreviewOptions = {},
): Promise<ChangePreview> {
  if (opts.ids !== undefined && opts.filter !== undefined) {
    throw new Error('provide ids or filter, not both');
  }
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? PREVIEW_DEFAULT_LIMIT)),
    MAX_ROWS_PAGE,
  );
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  let pkCol: string;
  let filters: { col: string; op: string; val?: unknown }[];
  if (opts.ids !== undefined) {
    pkCol = db.getPrimaryKey(table)[0] ?? 'id';
    filters = [{ col: pkCol, op: 'in', val: [...opts.ids] }];
  } else {
    ({ pkCol, filters } = bulkSelection(db, table, opts.filter, softDeletable));
  }

  const queryOpts: Parameters<Lattice['query']>[1] = {
    orderBy: pkCol,
    orderDir: 'asc',
    limit,
    offset,
  };
  queryOpts.filters = filters as NonNullable<typeof queryOpts.filters>;
  const matched = await db.query(readRelation, queryOpts);

  const countOpts: Parameters<Lattice['boundedCount']>[1] = { cap: MAX_ROWS_PAGE };
  countOpts.filters = filters as NonNullable<typeof countOpts.filters>;
  const total = await db.boundedCount(readRelation, countOpts);

  const knownCols = db.getRegisteredColumns(table) ?? {};
  const newColumns = Object.keys(set).filter(
    (c) => !Object.prototype.hasOwnProperty.call(knownCols, c),
  );

  const rows: RowChangePreview[] = matched.map((r) => {
    const fields = rowFieldDeltas(r, set as Partial<Row>);
    return {
      id: String(r[pkCol]),
      wouldChange: fields.some((f) => f.changed),
      fields,
    };
  });

  return {
    table,
    rows,
    total,
    totalIsCapped: total > MAX_ROWS_PAGE,
    limit,
    offset,
    newColumns,
  };
}

/** A field the viewer may not read: named, but carrying NO values and NO
 *  changed flag (either would leak the guarded cell — the flag alone is an
 *  equality oracle against the stored value). */
export interface MaskedFieldDelta {
  column: string;
  masked: true;
}

export type PreviewField = FieldDelta | MaskedFieldDelta;

/** A preview row after viewer masking. `wouldChange` degrades to null when the
 *  answer would reveal a masked cell (no visible field changes, but a masked
 *  field might). */
export interface MaskedRowPreview {
  id: string;
  wouldChange: boolean | null;
  fields: PreviewField[];
}

/**
 * Serve-time viewer mask for a preview page. For every column in `maskedCols`
 * the delta is replaced by a bare `{column, masked: true}` marker — no before
 * value, no after value, and no `changed` flag, because "would this value
 * change" is an equality oracle against a cell the viewer cannot read.
 * `wouldChange` is recomputed from the visible fields only: true when a
 * visible field changes, null (unknown) when only masked fields remain in
 * question, false when every visible field is a no-op and nothing is masked.
 * Pure — inputs are untouched.
 */
export function maskPreviewFields(
  rows: readonly RowChangePreview[],
  maskedCols: ReadonlySet<string>,
): MaskedRowPreview[] {
  return rows.map((r) => {
    const sawMasked = r.fields.some((f) => maskedCols.has(f.column));
    const fields: PreviewField[] = r.fields.map((f) =>
      maskedCols.has(f.column) ? { column: f.column, masked: true } : { ...f },
    );
    const visiblyChanged = fields.some((f) => 'changed' in f && f.changed);
    return {
      id: r.id,
      wouldChange: visiblyChanged ? true : sawMasked ? null : false,
      fields,
    };
  });
}
