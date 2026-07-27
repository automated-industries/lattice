/**
 * Where an import's bytes came from. The importer treats every source the same
 * way once it has records, but two decisions genuinely depend on the origin:
 * which label positional tables are named from, and how strictly the shape
 * contract is enforced (a spreadsheet tab narrowed to one column is ordinary; a
 * one-column, one-row "table" lifted out of a prose document is layout, not
 * data). Keeping the discrimination here means each import door states its
 * origin once instead of re-testing file extensions at every decision point.
 *
 * Pure and dependency-free — extension matching only, no I/O.
 */

export type PlanSourceKind = 'spreadsheet' | 'delimited' | 'document' | 'json' | 'unknown';

export interface PlanSource {
  kind: PlanSourceKind;
  /** The file name as the user knows it — the naming ladder's fallback label. */
  originalName: string;
}

/** Classify a source by its file name. Unrecognized names are 'unknown', which
 *  is treated exactly like structured data: named, but not shape-refused. */
export function planSourceKindFor(originalName: string): PlanSourceKind {
  if (/\.xlsx?$/i.test(originalName)) return 'spreadsheet';
  if (/\.(csv|tsv)$/i.test(originalName)) return 'delimited';
  if (/\.(docx|pptx)$/i.test(originalName)) return 'document';
  if (/\.json$/i.test(originalName)) return 'json';
  return 'unknown';
}

export function planSourceFor(originalName: string): PlanSource {
  return { kind: planSourceKindFor(originalName), originalName };
}
