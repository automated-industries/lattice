import { parseCalcExpr } from '../schema/calc-expr.js';
import type { WorkbookFormulaSummary } from './excel.js';
import { dominantPattern, translatePattern, type TranslateColumn } from './formula.js';
import { sourceRecords } from './infer.js';
import type { InferredEntity, ProposedSchema } from './types.js';

/**
 * Computed-table proposals for a structured import: fields the source clearly
 * computes itself (a spreadsheet column driven by one row-local formula) or is
 * begging to have organized (a category-shaped text column just past dimension
 * cardinality). Proposals are OPT-IN — nothing here creates anything; the
 * confirm card lists them unchecked and the apply route re-derives the same
 * proposals from the same inputs, so the two sides agree byte-for-byte.
 *
 * Deliberately sparing, and no model calls at inference time: calc fields need
 * a dominant translatable formula, classifier fields need a category-suggesting
 * name plus a cardinality just past what dimension extraction accepts. Raw
 * source columns import as plain values regardless of what is proposed here.
 */

/** One proposed computed field, with the evidence the card shows. */
export interface ComputedFieldProposal {
  /** Field name on the computed table (`<column>_calc` / `<column>_class`). */
  name: string;
  kind: 'calc' | 'ai_classify';
  /** Calc expression (calc-expr grammar), present for `calc`. */
  expr?: string;
  /** Classification instruction, present for `ai_classify`. */
  prompt?: string;
  /** Starter label set (most frequent values), present for `ai_classify`. */
  labels?: string[];
  /** Input column, present for `ai_classify`. */
  input?: string;
  /** Base-table columns the field reads. */
  sourceColumns: string[];
  /** 0..1 evidence strength: formula-dominance share / starter-label coverage. */
  confidence: number;
  /** Display evidence: the raw source formula / the most frequent value. */
  example?: string;
}

/** A proposed computed table over one materialized entity. */
export interface ComputedTableProposal {
  /** Base table: the materialized entity (post-rename). */
  entity: string;
  /** Proposed computed-table name (`<entity>_computed`, suffixed on collision). */
  table: string;
  fields: ComputedFieldProposal[];
}

export interface BuildComputedProposalsInput {
  /** The parsed source document (records are re-read for value statistics). */
  data: Record<string, unknown>;
  /** The inferred plan, post view-dedupe, PRE-rename (names mapped via `rename`). */
  plan: ProposedSchema;
  /** Inferred entity name → existing table name (from the schema match). */
  rename: Record<string, string>;
  /** Per-sheet formula summary for an Excel source; null for JSON. */
  formulaSummary: WorkbookFormulaSummary | null;
  /** Table names already in the workspace, for collision-free naming. */
  existingTables: string[];
}

/** Column names that suggest the values are a categorization of the rows. */
const CATEGORY_NAME_RE =
  /(^|_)(category|type|kind|status|stage|segment|class|tier|group|rating)(_|$)/;

/** Classifier gates: enough rows to be worth organizing, and a cardinality just
 *  past the dimension extractor's cap (≤ 64) without being per-row unique. */
const CLASSIFY_MIN_ROWS = 50;
const CLASSIFY_MIN_DISTINCT = 64; // exclusive — at or below, dimensions own it
const CLASSIFY_MAX_DISTINCT = 256;
const CLASSIFY_MAX_RATIO = 0.5;
const MAX_STARTER_LABELS = 8;
const MAX_CLASSIFIERS_PER_IMPORT = 3;

/** Distinct-value statistics of one source column (normalized values). */
interface ValueStats {
  nonNull: number;
  /** normalized value → { count, representative original casing }. */
  values: Map<string, { count: number; original: string }>;
}

function columnValueStats(records: Record<string, unknown>[], sourceKey: string): ValueStats {
  const values = new Map<string, { count: number; original: string }>();
  let nonNull = 0;
  for (const r of records) {
    const v = r[sourceKey];
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    if (v === '') continue;
    nonNull++;
    const key = String(v).trim().toLowerCase();
    const entry = values.get(key);
    if (entry) entry.count++;
    else values.set(key, { count: 1, original: String(v) });
  }
  return { nonNull, values };
}

/** Calc-field proposals: one per column whose formulas share a dominant,
 *  translatable row-local pattern over surviving scalar columns. */
function calcProposals(
  entity: InferredEntity,
  formulaSummary: WorkbookFormulaSummary | null,
): ComputedFieldProposal[] {
  const sheet = formulaSummary?.[entity.sourceKey];
  if (!sheet) return [];
  // A formula reference resolves only to a column that survived onto the
  // materialized entity (a header consumed by a link/dimension has no column
  // to read at query time — leaving it out fails the translation).
  const bySource = new Map(entity.columns.map((c) => [c.sourceKey, c]));
  const columnMap: Record<string, TranslateColumn> = {};
  for (const [letter, header] of Object.entries(sheet.columnLetters)) {
    const col = bySource.get(header);
    if (col) columnMap[letter] = { name: col.name, type: col.type };
  }
  const names = new Set(entity.columns.map((c) => c.name));
  const out: ComputedFieldProposal[] = [];
  for (const [header, stats] of Object.entries(sheet.columns)) {
    const col = bySource.get(header);
    if (!col) continue; // the formula column itself did not survive
    const pattern = dominantPattern(stats);
    if (pattern === null) continue;
    const expr = translatePattern(pattern, columnMap);
    if (expr === null) continue; // outside the translatable subset
    let sourceColumns: string[];
    try {
      const parsed = parseCalcExpr(expr, (path) => path.length === 1 && names.has(path[0] ?? ''));
      sourceColumns = parsed.columnPaths.map((p) => p.join('.'));
    } catch {
      continue; // defense in depth — translate already round-trips the parser
    }
    out.push({
      name: `${col.name}_calc`,
      kind: 'calc',
      expr,
      sourceColumns,
      confidence: (stats.patterns[pattern] ?? 0) / Math.max(1, stats.total),
      example: stats.example,
    });
  }
  return out;
}

/** The classifier candidate of an entity (at most one): a category-named text
 *  column that missed dimension extraction only on cardinality. */
function classifierProposal(
  entity: InferredEntity,
  data: Record<string, unknown>,
  plan: ProposedSchema,
): ComputedFieldProposal | null {
  if (entity.rowCount < CLASSIFY_MIN_ROWS) return null;
  // A column already consumed by a link or dimension is not in entity.columns;
  // one with a pending marginal-link question is — exclude it too (its meaning
  // is already being asked about).
  const linkFields = new Set(
    [...plan.linkages, ...plan.marginalLinks]
      .filter((l) => l.fromEntity === entity.name)
      .map((l) => l.fromField),
  );
  const records = sourceRecords(data, entity);
  for (const col of entity.columns) {
    if (col.type !== 'text') continue;
    if (col.name === entity.naturalKey) continue;
    if (linkFields.has(col.sourceKey)) continue;
    if (!CATEGORY_NAME_RE.test(col.name)) continue;
    const stats = columnValueStats(records, col.sourceKey);
    const distinct = stats.values.size;
    if (distinct <= CLASSIFY_MIN_DISTINCT || distinct > CLASSIFY_MAX_DISTINCT) continue;
    if (distinct / Math.max(1, records.length) > CLASSIFY_MAX_RATIO) continue;
    // Starter labels: the most frequent values (ties broken lexically so the
    // proposal is deterministic), in their representative original casing.
    const ranked = [...stats.values.entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1),
    );
    const top = ranked.slice(0, MAX_STARTER_LABELS);
    const labels = top.map(([, v]) => v.original);
    if (labels.length === 0) continue;
    const covered = top.reduce((sum, [, v]) => sum + v.count, 0);
    return {
      name: `${col.name}_class`,
      kind: 'ai_classify',
      input: col.name,
      prompt:
        `Classify each row by its "${col.name}" value into a small set of ` +
        `canonical categories, merging near-duplicate spellings and variants.`,
      labels,
      sourceColumns: [col.name],
      confidence: covered / Math.max(1, stats.nonNull),
      example: labels[0] ?? '',
    };
  }
  return null;
}

/**
 * Build the computed-table proposals for an import. Deterministic over its
 * inputs: entity order follows the plan, table names collide predictably
 * (`_2`, `_3`, …), and both the upload proposal and the apply route call this
 * with the same parsed data / plan / rename / summary.
 */
export function buildComputedProposals(
  input: BuildComputedProposalsInput,
): ComputedTableProposal[] {
  const { data, plan, rename, formulaSummary, existingTables } = input;
  const finalName = (n: string): string => rename[n] ?? n;
  const taken = new Set<string>(existingTables);
  for (const e of plan.entities) taken.add(finalName(e.name));
  for (const d of plan.dimensions) taken.add(d.name);
  for (const l of plan.linkages) {
    if (l.junction) taken.add(l.junction);
  }

  const out: ComputedTableProposal[] = [];
  let classifiers = 0;
  for (const entity of plan.entities) {
    const fields = calcProposals(entity, formulaSummary);
    if (classifiers < MAX_CLASSIFIERS_PER_IMPORT) {
      const classify = classifierProposal(entity, data, plan);
      if (classify) {
        fields.push(classify);
        classifiers++;
      }
    }
    if (fields.length === 0) continue;
    const base = `${finalName(entity.name)}_computed`;
    let table = base;
    for (let i = 2; taken.has(table); i++) table = `${base}_${String(i)}`;
    taken.add(table);
    out.push({ entity: finalName(entity.name), table, fields });
  }
  return out;
}
