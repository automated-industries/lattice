import {
  DIM_MAX_DISTINCT,
  DIM_MAX_RATIO,
  FREETEXT,
  NEVER_KEY,
  normalizeName,
} from '../../import/infer-core.js';
import type { ColumnStat, ModelProfile, PlanOp, PlanTier, TableProfile } from './types.js';

/**
 * The deterministic data-model rules engine.
 *
 * `detect(profile)` is a PURE function: no DB, no LLM, no clock, no randomness.
 * Given the same `ModelProfile` it always returns the same ordered `PlanOp[]`.
 * That reproducibility is the whole point — it turns the star-schema principles
 * (which shipped only as an LLM system prompt) into executable checks.
 *
 * Tiering follows the product rule: every REVERSIBLE structural fix is `auto`
 * (applied unattended); every DATA-REWRITING or reference-breaking op is
 * `propose` (surfaced for one-click review). See each rule for its tier.
 *
 * Idempotence/convergence: every check consults the EXISTING structure carried
 * on the profile (relations, junctions, computed views, sqlType) and emits
 * nothing for an already-satisfied state, so a clean model yields `[]` and a
 * dirty model converges monotonically.
 */

export interface DetectOptions {
  /** Coverage at/above which a FK relationship may be applied unattended (AUTO). */
  autoLinkCoverage?: number;
  /** Coverage at/above which a FK relationship is surfaced as a proposal. */
  proposeLinkCoverage?: number;
  /** A source FK column must have at least this many distinct sampled values to AUTO-apply. */
  minFkDistinct?: number;
  /** A source table must have at least this many rows to AUTO-apply a FK. */
  minFkRows?: number;
  /** Column-name Jaccard at/above which two tables are a merge candidate. */
  mergeColJaccard?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  autoLinkCoverage: 0.9,
  proposeLinkCoverage: 0.6,
  minFkDistinct: 8,
  minFkRows: 8,
  mergeColJaccard: 0.7,
};

/** Stable, human-readable fingerprint — also the dismiss key. Operands are
 *  pre-normalized by callers so the id is order-independent. */
function opId(kind: string, table: string, column = '', toTable = ''): string {
  return `${kind}:${table}:${column}:${toTable}`;
}

/** System / bookkeeping columns the planner never reasons about. */
function isSystemColumn(name: string): boolean {
  return (
    name === 'id' ||
    name === 'deleted_at' ||
    name === 'created_at' ||
    name === 'updated_at' ||
    name.startsWith('_')
  );
}

function tableByName(profile: ModelProfile): Map<string, TableProfile> {
  const m = new Map<string, TableProfile>();
  for (const t of profile.tables) m.set(t.name, t);
  return m;
}

/** A table the planner may add FK columns to (writable native table). */
function isRestructurable(t: TableProfile): boolean {
  return t.tier === 'lattice';
}

/** A table that can be a relationship TARGET (has a stable key; not a view/junction). */
function canBeLinkTarget(t: TableProfile): boolean {
  return t.tier !== 'junction' && t.tier !== 'computed' && t.naturalKey !== null;
}

function columnByName(t: TableProfile, name: string | null): ColumnStat | undefined {
  if (!name) return undefined;
  return t.columns.find((c) => c.name === name);
}

/** True when S already relates to a table named `target` (either direction / junction). */
function alreadyRelated(profile: ModelProfile, s: TableProfile, target: string): boolean {
  if (s.relations.some((r) => r.targetTable === target)) return true;
  const t = target;
  return profile.existingJunctions.some(
    (j) => (j.a === s.name && j.b === t) || (j.a === t && j.b === s.name),
  );
}

// ── R1: missing relationship (FK inference) ──────────────────────────────────
// A scalar text column whose sampled values resolve to another table's natural
// key is a foreign key. AUTO only when the false-positive gate (G2) clears —
// enough distinct values, enough rows, a full (uncapped) sample, and a real
// non-numeric dimension key; otherwise PROPOSE. Additive + reversible.
function detectRelationships(profile: ModelProfile, opts: Required<DetectOptions>): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const s of profile.tables) {
    if (!isRestructurable(s)) continue;
    for (const c of s.columns) {
      if (isSystemColumn(c.name) || c.isPrimaryKey || c.isForeignKey) continue;
      if (c.name === s.naturalKey) continue;
      if (c.inferredType !== 'text') continue; // FK values are text/uuid (parity with ingest inferrer)
      const nn = normalizeName(c.name);
      if (FREETEXT.has(nn) || NEVER_KEY.has(nn)) continue;
      if (c.sampleValues.length === 0 || c.distinctSampled === 0) continue;

      // Best target = most values matched; deterministic tie-break (G7): the
      // denominator (c.distinctSampled) is constant across candidates, so more
      // matches == higher coverage. Ties break to the smaller table (more
      // dimension-like) then the lexicographically-smaller name.
      let best: { t: TableProfile; nk: ColumnStat; matched: number } | null = null;
      for (const t of profile.tables) {
        if (t.name === s.name || !canBeLinkTarget(t)) continue;
        if (alreadyRelated(profile, s, t.name)) continue; // idempotence (G6)
        const nk = columnByName(t, t.naturalKey);
        if (!nk || nk.sampleValues.length === 0) continue;
        const nkSet = new Set(nk.sampleValues);
        let matched = 0;
        for (const v of c.sampleValues) if (nkSet.has(v)) matched++;
        if (matched === 0) continue;
        if (
          best === null ||
          matched > best.matched ||
          (matched === best.matched && t.rowCount < best.t.rowCount) ||
          (matched === best.matched && t.rowCount === best.t.rowCount && t.name < best.t.name)
        ) {
          best = { t, nk, matched };
        }
      }
      if (!best) continue;

      const coverage = best.matched / c.distinctSampled;
      if (coverage < opts.proposeLinkCoverage) continue; // noise — dropped

      // G2 hard gate for unattended apply. The target must be a GENUINE unique
      // key, not a low-cardinality column whose values coincidentally overlap:
      // require the target table to be FULLY sampled (its true size known) and its
      // natural key to be distinct on every one of those rows — i.e. proven unique
      // table-wide, not merely unique-in-a-partial-sample. A large/partially-sampled
      // target can't clear this and falls through to PROPOSE for human review.
      const targetKeyProvenUnique =
        !best.t.rowCountCapped &&
        best.t.sampledRowCount === best.t.rowCount &&
        best.t.rowCount > 0 &&
        best.nk.distinctSampled === best.t.sampledRowCount;
      const gatesPass =
        c.distinctSampled >= opts.minFkDistinct &&
        s.rowCount >= opts.minFkRows &&
        !c.distinctIsCapped &&
        !best.nk.distinctIsCapped &&
        best.nk.inferredType === 'text' && // a real dimension key, never a numeric id-space
        targetKeyProvenUnique &&
        coverage >= opts.autoLinkCoverage;

      const tier: PlanTier = gatesPass ? 'auto' : 'propose';
      ops.push({
        id: opId('add_relationship', s.name, c.name, best.t.name),
        kind: 'add_relationship',
        class: 'additive',
        tier,
        target: { table: s.name, column: c.name, toTable: best.t.name },
        rationale:
          `${String(best.matched)}/${String(c.distinctSampled)} distinct values in ` +
          `${s.name}.${c.name} match ${best.t.name}.${String(best.t.naturalKey)} ` +
          `→ ${s.name} references ${best.t.name}.`,
        confidence: round2(coverage),
        evidence: {
          matched: best.matched,
          distinct: c.distinctSampled,
          targetKey: best.t.naturalKey,
          coverage: round2(coverage),
          gatesPass,
        },
      });
    }
  }
  return ops;
}

// ── R3: document structural objects (junctions) ──────────────────────────────
// A junction table with no definition gets a deterministic, always-correct
// description. Meaningful entity/column definitions are the demoted LLM assist's
// job; here we only emit docs whose text is a pure structural fact. Additive but
// PROPOSE — a table definition is metadata that is not (yet) on the undo stack,
// so it is surfaced for one-click apply rather than written unattended (making
// set_definition revertible is a tracked follow-up).
function detectDocumentation(profile: ModelProfile): PlanOp[] {
  const ops: PlanOp[] = [];
  const byName = tableByName(profile);
  for (const j of profile.existingJunctions) {
    const t = byName.get(j.name);
    if (!t || t.hasDefinition) continue;
    ops.push({
      id: opId('document', j.name),
      kind: 'document',
      class: 'additive',
      tier: 'propose',
      target: { table: j.name },
      rationale: `Undocumented join table linking ${j.a} and ${j.b}.`,
      confidence: 1,
      evidence: { a: j.a, b: j.b, text: `Join table linking ${j.a} and ${j.b}.` },
    });
  }
  return ops;
}

// ── R5: extract embedded dimension (normalize repeated data) ─────────────────
// A repeated low-cardinality categorical column is an entity embedded across
// rows; extracting it into its own table + a link normalizes the model. This
// BACKFILLS FK values (data write) → PROPOSE.
function detectDimensions(profile: ModelProfile, linkedCols: Set<string>): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const s of profile.tables) {
    if (!isRestructurable(s)) continue;
    for (const c of s.columns) {
      if (isSystemColumn(c.name) || c.isPrimaryKey || c.isForeignKey) continue;
      if (c.name === s.naturalKey) continue;
      if (linkedCols.has(`${s.name}::${c.name}`)) continue; // R1 already links it to an existing table
      if (c.inferredType !== 'text') continue;
      const nn = normalizeName(c.name);
      if (FREETEXT.has(nn)) continue;
      if (c.distinctIsCapped) continue; // must know it is genuinely low-cardinality
      const ratio = c.distinctSampled / Math.max(1, s.sampledRowCount);
      const isDim =
        c.distinctSampled >= 2 && c.distinctSampled <= DIM_MAX_DISTINCT && ratio <= DIM_MAX_RATIO;
      if (!isDim) continue;
      if (alreadyRelated(profile, s, nn)) continue; // idempotence (G6): dimension already extracted
      ops.push({
        id: opId('extract_dimension', s.name, c.name, nn),
        kind: 'extract_dimension',
        class: 'restructure',
        tier: 'propose',
        target: { table: s.name, column: c.name, toTable: nn },
        rationale:
          `${s.name}.${c.name} repeats ${String(c.distinctSampled)} distinct values across ` +
          `${String(s.sampledRowCount)} rows — extract it into a "${nn}" table linked by relationship.`,
        confidence: round2(1 - ratio),
        evidence: {
          distinct: c.distinctSampled,
          sampledRows: s.sampledRowCount,
          ratio: round2(ratio),
        },
      });
    }
  }
  return ops;
}

// ── R6: duplicate rows ───────────────────────────────────────────────────────
// The natural key repeating within the bounded sample means duplicate real-world
// rows. Mutates user rows (soft-delete + relink) → PROPOSE. Self-idempotent:
// once deduped, the key stops repeating and the signal disappears.
function detectDuplicateRows(profile: ModelProfile): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const s of profile.tables) {
    if (!isRestructurable(s) || !s.naturalKey) continue;
    const nk = columnByName(s, s.naturalKey);
    if (!nk || nk.distinctIsCapped || s.sampledRowCount < 2) continue;
    if (nk.distinctSampled < s.sampledRowCount) {
      ops.push({
        id: opId('dedup_rows', s.name),
        kind: 'dedup_rows',
        class: 'restructure',
        tier: 'propose',
        target: { table: s.name },
        rationale:
          `${s.name} has ${String(s.sampledRowCount - nk.distinctSampled)} row(s) sharing a ` +
          `${s.naturalKey} value — likely duplicates to merge.`,
        confidence: 0.8,
        evidence: {
          key: s.naturalKey,
          sampledRows: s.sampledRowCount,
          distinctKeys: nk.distinctSampled,
        },
      });
    }
  }
  return ops;
}

// ── R7: near-duplicate tables ────────────────────────────────────────────────
// Two tables whose column sets overlap heavily and share a same-named natural
// key are likely the same concept split in two. Restructure → PROPOSE.
function detectMergeableTables(profile: ModelProfile, opts: Required<DetectOptions>): PlanOp[] {
  const ops: PlanOp[] = [];
  const tables = profile.tables.filter(isRestructurable);
  const colSet = (t: TableProfile): Set<string> =>
    new Set(t.columns.filter((c) => !isSystemColumn(c.name)).map((c) => normalizeName(c.name)));
  for (let i = 0; i < tables.length; i++) {
    for (let k = i + 1; k < tables.length; k++) {
      const a = tables[i];
      const b = tables[k];
      if (!a || !b) continue;
      if (!a.naturalKey || !b.naturalKey) continue;
      if (normalizeName(a.naturalKey) !== normalizeName(b.naturalKey)) continue;
      const sa = colSet(a);
      const sb = colSet(b);
      if (sa.size === 0 || sb.size === 0) continue;
      let inter = 0;
      for (const c of sa) if (sb.has(c)) inter++;
      const jaccard = inter / (sa.size + sb.size - inter);
      if (jaccard < opts.mergeColJaccard) continue;
      // Deterministic pair order: lexicographically smaller name is the survivor target.
      const lo = a.name < b.name ? a : b;
      const hi = a.name < b.name ? b : a;
      ops.push({
        id: opId('merge_tables', lo.name, '', hi.name),
        kind: 'merge_tables',
        class: 'restructure',
        tier: 'propose',
        target: { table: hi.name, toTable: lo.name },
        rationale:
          `${a.name} and ${b.name} share ${String(inter)} columns and the same key ` +
          `"${normalizeName(a.naturalKey)}" (${String(Math.round(jaccard * 100))}% overlap) — likely the same concept.`,
        confidence: round2(jaccard),
        evidence: {
          jaccard: round2(jaccard),
          sharedColumns: inter,
          key: normalizeName(a.naturalKey),
        },
      });
    }
  }
  return ops;
}

// ── R8: retype a mistyped column ─────────────────────────────────────────────
// A TEXT column whose sampled values are uniformly a narrower type. Rewrites
// stored values (dialect-divergent) → PROPOSE. The safe additive substitute
// (a computed cast view) is the demoted LLM assist / a follow-up; deterministic
// detection only flags it. Self-idempotent (once retyped, sqlType matches).
function detectRetypes(profile: ModelProfile): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const s of profile.tables) {
    if (!isRestructurable(s)) continue;
    for (const c of s.columns) {
      if (isSystemColumn(c.name) || c.isForeignKey) continue;
      if (c.sqlType !== 'text') continue; // only widen-free TEXT→typed
      if (c.inferredType === 'text') continue; // already text-shaped
      if (c.distinctIsCapped || c.distinctSampled < 1) continue;
      if (c.nullRate >= 1) continue;
      ops.push({
        id: opId('retype_column', s.name, c.name),
        kind: 'retype_column',
        class: 'restructure',
        tier: 'propose',
        target: { table: s.name, column: c.name },
        rationale: `${s.name}.${c.name} is TEXT but every value is ${c.inferredType} — retype it.`,
        confidence: 0.9,
        evidence: { from: 'text', to: c.inferredType, distinct: c.distinctSampled },
      });
    }
  }
  return ops;
}

// ── R9: canonicalize a problematic table name ────────────────────────────────
// A table name containing whitespace/punctuation (not merely uppercase) is a
// fragile identifier. Renames are reversible BUT reference-breaking → PROPOSE.
function detectRenames(profile: ModelProfile): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const s of profile.tables) {
    if (!isRestructurable(s)) continue;
    if (!/[^A-Za-z0-9_]/.test(s.name) && !/^[0-9]/.test(s.name)) continue; // only truly problematic names
    const canonical = normalizeName(s.name);
    if (canonical === s.name) continue; // idempotence
    ops.push({
      id: opId('canonical_rename', s.name, '', canonical),
      kind: 'canonical_rename',
      class: 'restructure',
      tier: 'propose',
      target: { table: s.name, toTable: canonical },
      rationale: `"${s.name}" is not a clean identifier — rename to "${canonical}".`,
      confidence: 1,
      evidence: { from: s.name, to: canonical },
    });
  }
  return ops;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Byte-stable (UTF-16 code-unit) order — deterministic across machines. Plain
 *  `String.localeCompare` uses the runtime's DEFAULT locale, which varies by host,
 *  so it would make the plan order (and therefore the unattended AUTO apply order)
 *  non-deterministic — contradicting the "same model → same plan" guarantee. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic total order: additive before restructure, auto before propose,
 *  then by kind, table, column, toTable — so the plan is byte-stable. */
const KIND_ORDER: Record<string, number> = {
  add_relationship: 0,
  document: 1,
  extract_dimension: 2,
  dedup_rows: 3,
  merge_tables: 4,
  retype_column: 5,
  canonical_rename: 6,
};

function comparePlanOps(a: PlanOp, b: PlanOp): number {
  const classRank = (o: PlanOp): number => (o.class === 'additive' ? 0 : 1);
  const tierRank = (o: PlanOp): number => (o.tier === 'auto' ? 0 : 1);
  return (
    classRank(a) - classRank(b) ||
    tierRank(a) - tierRank(b) ||
    (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
    cmp(a.target.table, b.target.table) ||
    cmp(a.target.column ?? '', b.target.column ?? '') ||
    cmp(a.target.toTable ?? '', b.target.toTable ?? '')
  );
}

/**
 * Run every rule against a profile and return the deterministic, ordered plan.
 * Pure: no side effects, no I/O.
 */
export function detect(profile: ModelProfile, options: DetectOptions = {}): PlanOp[] {
  const opts: Required<DetectOptions> = { ...DEFAULTS, ...options };
  const relationshipOps = detectRelationships(profile, opts);
  const linkedCols = new Set(
    relationshipOps.map((o) => `${o.target.table}::${o.target.column ?? ''}`),
  );
  const ops: PlanOp[] = [
    ...relationshipOps,
    ...detectDocumentation(profile),
    ...detectDimensions(profile, linkedCols),
    ...detectDuplicateRows(profile),
    ...detectMergeableTables(profile, opts),
    ...detectRetypes(profile),
    ...detectRenames(profile),
  ];
  // De-dup by fingerprint (a column can't be both a FK and a dimension — the FK
  // rule wins because it runs first and consumes higher-priority intent).
  const seen = new Set<string>();
  const unique: PlanOp[] = [];
  for (const op of ops) {
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    unique.push(op);
  }
  unique.sort(comparePlanOps);
  return unique;
}
