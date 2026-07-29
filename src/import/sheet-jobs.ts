/**
 * Per-sheet import units.
 *
 * A large workbook is imported as MANY small, independent units — one per sheet —
 * instead of a single all-sheets-at-once plan. A 77-tab workbook then lands as 77
 * ordinary one-table imports, none of which trips the per-import table cap, rather
 * than one 77-table plan that the cap refuses outright.
 *
 * Cross-sheet foreign-key inference is deliberately given up at import time: each
 * sheet is modeled on its own. Relationships across the resulting tables are
 * re-derived afterwards over the whole workspace, so nothing is lost — it is just
 * recovered later, against more context, instead of guessed sheet-by-sheet here.
 */

/**
 * A high overall ceiling on the total tables one workbook may create across all of
 * its per-sheet units. It clears a large multi-tab workbook (dozens of sheets, a
 * few tables each) with room to spare — its only job is to stop a pathological
 * file. Reaching it is REPORTED (some sheets left for a separate import), never a
 * silent drop and never a dead-end refusal of the whole workbook.
 */
export const MAX_WORKBOOK_TABLES = 1000;

/**
 * One per-sheet import unit: a single source key isolated with its paired columnar
 * header metadata, so the sheet flows through infer → materialize entirely on its
 * own.
 */
export interface SheetJob {
  /** The source key — an Excel sheet name, or a JSON top-level table name. */
  key: string;
  /** The isolated sub-source: this key's records plus its `<key>Cols` metadata, if any. */
  data: Record<string, unknown>;
}

/** True when `k` is the `<base>Cols` header metadata paired with another record key,
 *  not a table in its own right. */
function isColumnMetaKey(data: Record<string, unknown>, k: string): boolean {
  return k.endsWith('Cols') && Array.isArray(data[k.slice(0, -4)]);
}

/**
 * Split a parsed multi-key dataset into one job per data table (source key),
 * carrying each key's paired `<key>Cols` header metadata with it. Non-array keys
 * and orphan `<key>Cols` metadata are ignored. Source-key order is preserved, so a
 * workbook imports its sheets left-to-right.
 */
export function splitSheetJobs(data: Record<string, unknown>): SheetJob[] {
  const jobs: SheetJob[] = [];
  for (const k of Object.keys(data)) {
    if (!Array.isArray(data[k])) continue;
    if (isColumnMetaKey(data, k)) continue; // header metadata for another key, not its own table
    const sub: Record<string, unknown> = { [k]: data[k] };
    const colsKey = k + 'Cols';
    if (Array.isArray(data[colsKey])) sub[colsKey] = data[colsKey];
    jobs.push({ key: k, data: sub });
  }
  return jobs;
}

/**
 * A file reference scoped to a single sheet of a multi-sheet workbook. The base
 * files-row id and the sheet name are joined so a per-sheet apply can re-read
 * exactly one sheet, and so two sheets of the SAME file get distinct references.
 * The sheet name is percent-encoded so it can never contain the `#` separator.
 */
export function sheetFileRef(fileId: string, sheet: string): string {
  return fileId + '#' + encodeURIComponent(sheet);
}

/**
 * Inverse of {@link sheetFileRef}: split a reference into its base files-row id and
 * the sheet it is scoped to (`null` when the reference names the whole file). A
 * files-row id is a UUID and never contains `#`, so the first `#` is unambiguously
 * the separator.
 */
export function parseSheetFileRef(ref: string): { fileId: string; sheet: string | null } {
  const hash = ref.indexOf('#');
  if (hash < 0) return { fileId: ref, sheet: null };
  return { fileId: ref.slice(0, hash), sheet: decodeURIComponent(ref.slice(hash + 1)) };
}
