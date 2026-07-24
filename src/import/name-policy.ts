import { normalizeName } from './infer-core.js';
import type { InferredDimension, InferredEntity } from './types.js';

/**
 * The ONE shared table-name policy — the single predicate the importer, the
 * assistant, and the ingest pipeline all consult, so "what counts as an
 * anonymous table" is defined in exactly one place. Before this module the
 * knowledge was split and inconsistent: `import-auto.ts` knew `table_\d+` and
 * the data-model planner (`gui/planner/detect.ts`) did not, so a positional
 * `table_1` slipped straight through inference into a materialized table.
 *
 * Pure + dependency-free (no DB, no LLM). Same name in → same verdict out, for
 * every user — deterministic behaviour, not a prompt rule.
 */

/**
 * A single import that would create more than this many tables requires an
 * explicit override (the confirm card sets it on Apply). Lives here — not in
 * `gui/import-routes.ts` — so BOTH the apply route and the faithful assistant
 * path (`import-auto.ts`) read the same cap. (`import-routes.ts` already imports
 * from `import/`, so importing the other direction would risk a cycle.)
 */
export const MAX_IMPORT_TABLES = 50;

/**
 * True when `name` is a purely positional / placeholder table name that carries
 * no meaning to the user — `Table 1`, `Sheet3`, `untitled`, the `field` and
 * `f_<n>` fallbacks `normalizeName` emits, and so on.
 *
 * Applied to the POST-`normalizeName` form. `normalizeName` inserts a separator
 * only at a lower→UPPER camel boundary, never before a digit — `Table 1` becomes
 * `table_1` but `Sheet1` becomes `sheet1` — so the separator before the ordinal
 * must be optional.
 *
 * Deliberately NOT anonymous:
 *   - `data` — `csvToRecords`' legitimate basename fallback (`csv.ts`). It is not
 *     in the alternation, so it passes.
 *   - `f1` / `f2` — the `f_` alternative REQUIRES its underscore, because it exists
 *     only to catch `normalizeName`'s digit-prefix artifact (`2024` → `f_2024`),
 *     which always carries the underscore. A literal `f1` is a user-typed name
 *     (a fund tab, a form code) and must never be flagged.
 *   - `f_2026_rates` — the artifact form is `f_` + digits ONLY; `f_` followed by
 *     more than digits is a real name (`2026 Rates.xlsx`).
 *   - `column_3` / `col_2` — a COLUMN-name artifact (`doc-tables.ts` deduped-header
 *     `Column N`), not a table-name concern; it is fixed at its own source. Keeping
 *     it out also matters for dimensions: dimension names derive from column names,
 *     and a real categorical column blank-headered into `Column N` must degrade
 *     gracefully rather than be refused.
 */
export function isAnonymousName(name: string): boolean {
  return /^(?:(?:table|sheet|tab|field|untitled|unnamed)_?\d*|f_\d+)$/.test(name);
}

/** Verdict from a shape check: ok, or a human-readable reason it was rejected. */
export interface ShapeVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * The shared entity shape gate, enforced as a materialize-time pre-flight and by
 * the assistant/ingest create-entity path:
 *   N1 — the (normalized) name is not anonymous.
 *   N2 — at least one data row, when rows are being written (`requireRows`).
 *
 * NB: there is deliberately NO column-count bar here. `infer.ts` strips dimension
 * and linkage fields off an entity before emitting it, so a perfectly legitimate
 * entity can arrive with a single column — a `>= 2 columns` rule would reject real
 * CSV/Excel imports. The document-only `>= 2 columns` check stays where it already
 * is and is already correct (`hasSubstantiveDocTable`).
 */
export function checkEntityShape(
  entity: Pick<InferredEntity, 'name' | 'rowCount'>,
  opts: { requireRows: boolean } = { requireRows: false },
): ShapeVerdict {
  if (isAnonymousName(normalizeName(entity.name))) {
    return { ok: false, reason: `anonymous table name "${entity.name}"` };
  }
  if (opts.requireRows && entity.rowCount < 1) {
    return { ok: false, reason: `table "${entity.name}" has no rows` };
  }
  return { ok: true };
}

/**
 * The dimension shape gate: N1 only. `InferredDimension` has no `columns` field
 * (it is `{ name, sourceField, fromEntities, distinctValues }`), so the entity
 * predicate cannot even type-check against one — a column bar applied to
 * dimensions would throw on the first import that infers any repeated categorical
 * column, which is the common case.
 */
export function checkDimensionName(dim: Pick<InferredDimension, 'name'>): ShapeVerdict {
  if (isAnonymousName(normalizeName(dim.name))) {
    return { ok: false, reason: `anonymous dimension name "${dim.name}"` };
  }
  return { ok: true };
}

/**
 * Raw source labels are capped so the normalized identifier stays inside
 * Postgres's 63-byte NAMEDATALEN. normalizeName only ever emits ASCII (so chars
 * == bytes) but can GROW a label (a camelCase boundary inserts `_`), so the raw
 * cap leaves headroom. SQLite would accept longer names — and the CI runs on
 * SQLite — which is exactly why the bound lives at the source instead of being
 * discovered as silent truncation in production Postgres.
 */
export const MAX_SOURCE_LABEL_CHARS = 40;

/** Trim a label to the cap at a word boundary where possible. */
export function capLabel(label: string): string {
  const t = label.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_SOURCE_LABEL_CHARS) return t;
  const cut = t.slice(0, MAX_SOURCE_LABEL_CHARS + 1);
  const atWord = cut.lastIndexOf(' ');
  return (
    atWord > MAX_SOURCE_LABEL_CHARS / 2
      ? cut.slice(0, atWord)
      : cut.slice(0, MAX_SOURCE_LABEL_CHARS)
  ).trim();
}

/**
 * A display label derived from a file name: basename, extension stripped,
 * whitespace collapsed, capped — and never anonymous (an `untitled.docx` or
 * `table.xlsx` falls through to the generic 'document', which the predicate
 * deliberately passes). The shared fallback-label rung for every source kind.
 */
export function labelFromFilename(originalName: string, generic = 'document'): string {
  const base = (originalName.split(/[\\/]/).pop() ?? originalName).replace(/\.[^.]+$/, '');
  const label = capLabel(base);
  if (!label || isAnonymousName(normalizeName(label))) return generic;
  return label;
}

/**
 * Rename anonymous top-level keys of a parsed structured source (`Sheet1`, a
 * JSON `table_1`, …) to a uniquified label derived from the FILE name, before
 * inference ever sees them. This is the source-level backstop for the doors the
 * document naming ladder does not cover — Excel sheet names and JSON keys —
 * so the materialize pre-flight never has to drop a default-named workbook.
 *
 * Preserves the columnar `<key>Cols` pairing (the dictionary key is renamed in
 * lock-step) and leaves non-array keys untouched (inference skips them anyway).
 * Deterministic and door-agnostic: both the upload proposal and the apply
 * route call it with the same original name, so they keep naming identically.
 */
export function applySourceNameFallback(
  data: Record<string, unknown>,
  originalName: string,
): Record<string, unknown> {
  const keys = Object.keys(data);
  const anonymous = keys.filter((k) => Array.isArray(data[k]) && isAnonymousName(normalizeName(k)));
  if (anonymous.length === 0) return data;
  const label = labelFromFilename(originalName);
  const taken = new Set(keys.map((k) => normalizeName(k)));
  const out: Record<string, unknown> = {};
  const renames = new Map<string, string>();
  for (const k of anonymous) {
    let candidate = label;
    let n = 2;
    while (taken.has(normalizeName(candidate))) {
      candidate = `${label} ${String(n)}`;
      n++;
    }
    taken.add(normalizeName(candidate));
    renames.set(k, candidate);
  }
  for (const k of keys) {
    const target = renames.get(k);
    if (target !== undefined) {
      out[target] = data[k];
      continue;
    }
    // A columnar dictionary rides with its renamed data key.
    const baseKey = k.endsWith('Cols') ? k.slice(0, -4) : null;
    const pairedTarget = baseKey != null ? renames.get(baseKey) : undefined;
    if (pairedTarget !== undefined) {
      out[pairedTarget + 'Cols'] = data[k];
      continue;
    }
    out[k] = data[k];
  }
  return out;
}
