import { isSystemColumn } from './infer-core.js';
import type { InferredType } from './types.js';

/**
 * The table-ROLE ladder: what a table IS, decided from its shape.
 *
 * The importer already infers a table's COLUMNS and its LINKS; what it never
 * recorded is the thing a person states in one word — "that's the orders fact",
 * "that's just a lookup list". Without it every downstream consumer re-derives
 * the same judgement from scratch (and inconsistently), and the assistant has to
 * guess it from the table's name — the least reliable signal on imported data,
 * where half the tables arrive called `Sheet1`.
 *
 * So this module answers it ONCE, deterministically:
 *
 *   link       a pure relationship row — two keys pointing at two tables and
 *              nothing else. (The junction/link tables the planner and the
 *              importer already materialize.)
 *   document   rows that ARE text: one long-form body per row.
 *   fact       the many-side of the model — rows that reference two or more
 *              other tables and carry measurements or a timestamp.
 *   dimension  the one-side — a table OTHER tables point at, smaller than the
 *              tables that reference it. (What `extract_dimension` produces.)
 *   reference  a standalone lookup list: small, keyed, referenced by nothing yet.
 *
 * Two properties are load-bearing and are asserted by the tests:
 *
 *  1. DETERMINISTIC — same input, same output. No model call, no clock, no
 *     randomness, no I/O. The ladder is a fixed sequence of guarded rungs and
 *     the first one that matches wins, so a verdict is always explainable by a
 *     single rule id.
 *  2. NAME-BLIND — no rung reads a table's name. Roles come from row counts,
 *     key cardinality, column types, value shape, and which way the foreign keys
 *     point. A name is exactly the signal that is missing or meaningless on
 *     imported data, so relying on it would make the classification worst
 *     precisely where it is needed most. (Table names ARE used to resolve
 *     relations to their targets, and appear in a link's grain description —
 *     neither of which changes a role.)
 *
 * The input types are structural on purpose: a planner `TableProfile` /
 * `ColumnStat` satisfies them as-is, so the planner can classify what it already
 * profiled without a second pass over the database, and this module stays free
 * of any dependency on the GUI layer.
 */

/** What a table is, in the model. */
export type TableRole = 'fact' | 'dimension' | 'link' | 'document' | 'reference';

/** How a table's stored role was decided. A user-set role is never overwritten. */
export type RoleSource = 'inferred' | 'user';

/** The rung of the ladder that decided a verdict — the "why", as a stable id. */
export type RoleRuleId =
  | 'L1-link'
  | 'L2-document'
  | 'L3-fact'
  | 'L4-dimension'
  | 'L5-reference'
  | 'L6-fallback';

/** True for a value that is one of the five roles (a stored string is untyped). */
export function isTableRole(v: unknown): v is TableRole {
  return v === 'fact' || v === 'dimension' || v === 'link' || v === 'document' || v === 'reference';
}

/** True for a stored role-provenance value. */
export function isRoleSource(v: unknown): v is RoleSource {
  return v === 'inferred' || v === 'user';
}

/** Mean length at/above which a text column's values are long-form prose rather
 *  than a label — the signal that the ROW is a document. */
export const LONG_TEXT_CHARS = 120;

/** A standalone lookup list stays a lookup list only while it is small. */
export const REFERENCE_MAX_ROWS = 500;

/** ...and narrow: a lookup carries a key and a couple of attributes, not a record. */
export const REFERENCE_MAX_PAYLOAD_COLUMNS = 4;

/** The column facts the ladder reads (a planner `ColumnStat` satisfies this). */
export interface RoleColumn {
  name: string;
  inferredType: InferredType;
  distinctSampled: number;
  /** Normalized distinct sample values — their LENGTH is the free-text signal. */
  sampleValues: readonly string[];
  isForeignKey: boolean;
  isPrimaryKey: boolean;
}

/** A relationship as the ladder reads it (a planner `NormalizedRelation` fits). */
export interface RoleRelation {
  kind: 'belongsTo' | 'hasMany';
  targetTable: string;
}

/** The table facts the ladder reads (a planner `TableProfile` satisfies this). */
export interface RoleTable {
  name: string;
  /** Bounded row count. A capped count is a lower bound, which is all the
   *  thresholds here need (they only ever ask "is this big?"). */
  rowCount: number;
  sampledRowCount: number;
  naturalKey: string | null;
  columns: readonly RoleColumn[];
  relations: readonly RoleRelation[];
}

/**
 * The model-level facts a single table cannot know about itself: how big the
 * tables it points AT are, and how big the tables pointing at IT are. Fan-in and
 * fan-out are what separate a fact from a dimension, so they are passed in
 * rather than guessed.
 */
export interface RoleModelContext {
  /** Row counts of the tables this one references (belongsTo), when profiled. */
  referencedRowCounts: readonly number[];
  /** Row counts of the tables that reference this one. Length = fan-in. */
  referrerRowCounts: readonly number[];
}

export interface RoleVerdict {
  table: string;
  role: TableRole;
  /** The rung that decided it. */
  rule: RoleRuleId;
  /** 0..1 — how strongly the deciding rung's guard cleared. */
  confidence: number;
  /**
   * True when the verdict may be applied UNATTENDED. A rung can match on its
   * minimum guard and still be a judgement call (a fact with no measures, a
   * dimension with no stable key); those are classified but never auto-applied,
   * because a wrong stored role is worse than an absent one.
   */
  unambiguous: boolean;
  /** What one row of this table means, in words ("one row per invoice_no"). */
  grain: string;
  /** One line of structural facts — no prose, no model output. */
  rationale: string;
  /** The numbers the rung actually weighed. */
  evidence: Record<string, number | string | boolean>;
}

/** Columns that carry data (excludes id/created_at/updated_at/deleted_at/_*). */
function dataColumns(t: RoleTable): RoleColumn[] {
  return t.columns.filter((c) => !isSystemColumn(c.name) && !c.isPrimaryKey);
}

/** Data columns that are NOT foreign keys — the table's own payload. */
function payloadColumns(t: RoleTable): RoleColumn[] {
  return dataColumns(t).filter((c) => !c.isForeignKey);
}

/** Distinct tables this one points at through a belongsTo. */
function outboundTargets(t: RoleTable): string[] {
  const seen = new Set<string>();
  for (const r of t.relations) if (r.kind === 'belongsTo') seen.add(r.targetTable);
  return [...seen].sort();
}

/** Payload columns holding a measurement (the numeric core of a fact row). */
function measureColumns(cols: RoleColumn[]): RoleColumn[] {
  return cols.filter((c) => c.inferredType === 'integer' || c.inferredType === 'real');
}

/** Payload columns holding a point in time (a fact's other defining shape). */
function temporalColumns(cols: RoleColumn[]): RoleColumn[] {
  return cols.filter((c) => c.inferredType === 'date' || c.inferredType === 'datetime');
}

/** Mean character length of a column's sampled values (0 when nothing sampled). */
function meanValueLength(c: RoleColumn): number {
  if (c.sampleValues.length === 0) return 0;
  let total = 0;
  for (const v of c.sampleValues) total += v.length;
  return total / c.sampleValues.length;
}

/** Payload columns whose sampled values are long-form text (prose, not labels). */
function longTextColumns(cols: RoleColumn[]): RoleColumn[] {
  return cols.filter((c) => c.inferredType === 'text' && meanValueLength(c) >= LONG_TEXT_CHARS);
}

/** What one row means. Derived from the key, never from the role. */
function grainOf(t: RoleTable, linkTargets: string[]): string {
  if (linkTargets.length >= 2) return `one row per ${linkTargets.join(' + ')}`;
  if (t.naturalKey) return `one row per ${t.naturalKey}`;
  return 'one row per record';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify ONE table. Prefer {@link classifyRoles}, which derives the model
 * context (fan-in / fan-out row counts) for a whole set of tables at once; this
 * is the single-table form for a caller that already has that context.
 */
export function classifyRole(t: RoleTable, ctx: RoleModelContext): RoleVerdict {
  const payload = payloadColumns(t);
  const targets = outboundTargets(t);
  const outbound = targets.length;
  const inbound = ctx.referrerRowCounts.length;
  const measures = measureColumns(payload);
  const temporal = temporalColumns(payload);
  const longText = longTextColumns(payload);
  const grain = grainOf(t, outbound >= 2 && payload.length === 0 ? targets : []);
  const maxReferenced = ctx.referencedRowCounts.reduce((a, b) => Math.max(a, b), 0);
  const maxReferrer = ctx.referrerRowCounts.reduce((a, b) => Math.max(a, b), 0);

  const base = {
    table: t.name,
    grain,
    evidence: {
      rows: t.rowCount,
      payloadColumns: payload.length,
      outbound,
      inbound,
      measures: measures.length,
      temporal: temporal.length,
      longText: longText.length,
      hasKey: t.naturalKey !== null,
    },
  };

  // L1 — a pure relationship row: it points at two or more tables and has no
  // payload of its own, so the row IS the relationship. Unambiguous by
  // construction: nothing else has that shape.
  if (outbound >= 2 && payload.length === 0) {
    return {
      ...base,
      role: 'link',
      rule: 'L1-link',
      confidence: 1,
      unambiguous: true,
      rationale: `${String(outbound)} foreign keys and no other columns — each row links ${targets.join(' + ')}.`,
    };
  }

  // L2 — the row IS text: at least a third of the payload is long-form prose.
  // Checked before the star rungs because a document table often also carries a
  // reference or two (an author, a source), which must not make it a fact.
  if (longText.length >= 1 && longText.length * 3 >= payload.length) {
    return {
      ...base,
      role: 'document',
      rule: 'L2-document',
      confidence: round2(Math.min(1, longText.length / Math.max(1, payload.length) + 0.34)),
      unambiguous: longText.length * 2 >= payload.length,
      rationale:
        `${String(longText.length)} of ${String(payload.length)} data column(s) hold long-form text ` +
        `(≥ ${String(LONG_TEXT_CHARS)} characters on average) — each row is a document.`,
    };
  }

  // L3 — the many-side: references two or more tables, is at least as big as
  // every table it references, and carries measurements or a timestamp. The
  // size test is what stops a snowflaked dimension (which also has two parents)
  // from being read as a fact.
  if (outbound >= 2 && t.rowCount >= maxReferenced && measures.length + temporal.length >= 1) {
    return {
      ...base,
      role: 'fact',
      rule: 'L3-fact',
      confidence: measures.length >= 1 ? 0.9 : 0.7,
      unambiguous: measures.length >= 1,
      rationale:
        `References ${String(outbound)} tables, holds ${String(measures.length)} measure(s) and ` +
        `${String(temporal.length)} timestamp(s), and has ${String(t.rowCount)} rows to their ${String(maxReferenced)}.`,
    };
  }

  // L4 — the one-side: something points at it, and it is not bigger than the
  // table doing the pointing.
  if (inbound >= 1 && t.rowCount <= maxReferrer) {
    return {
      ...base,
      role: 'dimension',
      rule: 'L4-dimension',
      confidence: t.naturalKey !== null ? 0.9 : 0.6,
      unambiguous: t.naturalKey !== null,
      rationale:
        `${String(inbound)} table(s) reference it and it has ${String(t.rowCount)} rows to their ` +
        `${String(maxReferrer)}${t.naturalKey ? `, keyed by ${t.naturalKey}` : ''}.`,
    };
  }

  // L5 — a standalone lookup: small, narrow, and connected to nothing yet.
  if (
    inbound === 0 &&
    outbound === 0 &&
    t.rowCount <= REFERENCE_MAX_ROWS &&
    payload.length <= REFERENCE_MAX_PAYLOAD_COLUMNS
  ) {
    return {
      ...base,
      role: 'reference',
      rule: 'L5-reference',
      confidence: t.naturalKey !== null ? 0.8 : 0.5,
      unambiguous: t.naturalKey !== null && t.rowCount >= 2,
      rationale:
        `${String(t.rowCount)} rows across ${String(payload.length)} data column(s), referenced by nothing — ` +
        `a standalone list.`,
    };
  }

  // L6 — nothing matched decisively. Still answer (every table gets a role), but
  // never unattended: this is the rung that says "a person should look".
  const big = t.rowCount > REFERENCE_MAX_ROWS;
  return {
    ...base,
    role: big || outbound >= 1 || measures.length >= 1 ? 'fact' : 'reference',
    rule: 'L6-fallback',
    confidence: 0.3,
    unambiguous: false,
    rationale:
      `No rule matched decisively (${String(t.rowCount)} rows, ${String(outbound)} outbound and ` +
      `${String(inbound)} inbound reference(s), ${String(payload.length)} data column(s)).`,
  };
}

/**
 * Classify every table in a model. Fan-in / fan-out row counts are derived here
 * from the relations the tables declare, so the result depends only on the SET
 * of tables — not on the order they are passed in.
 */
export function classifyRoles(tables: readonly RoleTable[]): Map<string, RoleVerdict> {
  const rowsByTable = new Map<string, number>();
  for (const t of tables) rowsByTable.set(t.name, t.rowCount);

  // referrers[X] = the row counts of the tables that point at X.
  const referrers = new Map<string, number[]>();
  for (const t of tables) {
    for (const target of outboundTargets(t)) {
      const list = referrers.get(target);
      if (list) list.push(t.rowCount);
      else referrers.set(target, [t.rowCount]);
    }
  }

  const out = new Map<string, RoleVerdict>();
  for (const t of tables) {
    const referencedRowCounts = outboundTargets(t)
      .map((name) => rowsByTable.get(name))
      .filter((n): n is number => n !== undefined);
    // Sorted so the context is a pure function of the table SET, independent of
    // the iteration order that produced it.
    const referrerRowCounts = [...(referrers.get(t.name) ?? [])].sort((a, b) => a - b);
    out.set(t.name, classifyRole(t, { referencedRowCounts, referrerRowCounts }));
  }
  return out;
}
