import { normalizeText } from '../dedup/normalize.js';
import { inferFieldType, normalizeName, sourceRecords } from './infer.js';
import type { DetectedView, ProposedSchema } from './types.js';

/**
 * Structural dedup + view detection. After {@link inferSchema}, this looks ACROSS
 * entities for the case where one entity is a reconstructable per-value slice of
 * another — e.g. a per-fund tab whose rows are `master WHERE fund = X`. Such
 * entities become read-only DB views of the master instead of duplicate tables.
 *
 * Real exports rarely line up cell-for-cell (columns get renamed, values drift
 * between tabs), so detection is IDENTITY-based, not exact-row-based: an entity A
 * is a view of B when (a) A and B are structurally similar (most of A's columns
 * are also on B), (b) B has a column whose value equals A's tab name on some rows
 * (the discriminator), and (c) ≥80% of A's identifying values appear among those
 * matched B rows. Conservative + reported for review; nothing is applied silently.
 */

interface EntityData {
  name: string;
  sourceKey: string;
  cols: string[];
  colSource: Map<string, string>;
  normRows: Record<string, unknown>[];
}

const SAMPLE = 300;
const VIEW_MIN_OVERLAP = 0.8;

function buildEntityData(plan: ProposedSchema, data: Record<string, unknown>): EntityData[] {
  return plan.entities.map((e) => {
    const records = sourceRecords(data, e);
    const colSet = new Set<string>();
    const colSource = new Map<string, string>();
    for (const r of records.slice(0, SAMPLE)) {
      for (const k of Object.keys(r)) {
        const n = normalizeName(k);
        colSet.add(n);
        if (!colSource.has(n)) colSource.set(n, k);
      }
    }
    const normRows = records.map((r) => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(r)) o[normalizeName(k)] = r[k];
      return o;
    });
    return { name: e.name, sourceKey: e.sourceKey, cols: [...colSet], colSource, normRows };
  });
}

/** The most-identifying shared column (mostly-text, highest distinct count). */
function pickIdentity(a: EntityData, shared: string[]): string | null {
  let bestCol: string | null = null;
  let bestDistinct = -1;
  for (const c of shared) {
    const vals = new Set<string>();
    let textish = 0;
    let total = 0;
    for (const r of a.normRows) {
      const v = r[c];
      if (v === null || v === undefined || v === '') continue;
      total++;
      if (typeof v === 'string') textish++;
      vals.add(normalizeText(v));
    }
    if (total === 0 || textish / total < 0.7) continue;
    if (vals.size > bestDistinct) {
      bestDistinct = vals.size;
      bestCol = c;
    }
  }
  return bestCol;
}

export function dedupeAndDetectViews(
  plan: ProposedSchema,
  data: Record<string, unknown>,
): { plan: ProposedSchema; views: DetectedView[] } {
  const entities = buildEntityData(plan, data);
  const views: DetectedView[] = [];
  const asView = new Set<string>();
  const colKeeps: { master: EntityData; col: string }[] = [];

  for (const a of entities) {
    if (a.cols.length < 2 || a.normRows.length === 0) continue;
    const tabName = normalizeText(a.sourceKey);
    if (!tabName) continue;
    const aColSet = new Set(a.cols);

    let best:
      | { master: EntityData; disc: string; value: string; matched: number; overlap: number }
      | null = null;

    for (const b of entities) {
      if (b.name === a.name || asView.has(b.name)) continue;
      if (b.normRows.length < a.normRows.length) continue; // master must be the bigger set
      const bColSet = new Set(b.cols);
      const shared = a.cols.filter((c) => bColSet.has(c));
      if (shared.length < Math.max(2, Math.ceil(a.cols.length * 0.5))) continue; // not similar enough

      const identity = pickIdentity(a, shared);
      if (!identity) continue;
      const aIds = new Set(a.normRows.map((r) => normalizeText(r[identity])).filter((v) => v !== ''));
      if (aIds.size === 0) continue;

      // Discriminator: a master column (one A does NOT have) whose value equals
      // the tab name on some rows. Those rows are the candidate slice.
      for (const disc of b.cols) {
        if (aColSet.has(disc)) continue;
        const sub = b.normRows.filter((r) => normalizeText(r[disc]) === tabName);
        if (sub.length === 0) continue;
        const bIds = new Set(sub.map((r) => normalizeText(r[identity])).filter((v) => v !== ''));
        let inter = 0;
        for (const id of aIds) if (bIds.has(id)) inter++;
        const overlap = inter / aIds.size;
        if (overlap < VIEW_MIN_OVERLAP) continue;
        const rawRow = sub.find((r) => typeof r[disc] === 'string' || typeof r[disc] === 'number');
        const raw = rawRow ? rawRow[disc] : undefined;
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        if (
          best === null ||
          overlap > best.overlap ||
          (overlap === best.overlap && b.cols.length > best.master.cols.length)
        ) {
          best = { master: b, disc, value: String(raw), matched: sub.length, overlap };
        }
      }
    }

    if (!best) continue;
    views.push({
      name: a.name,
      master: best.master.name,
      filterColumn: best.disc,
      filterValue: best.value,
      matchedRows: best.matched,
    });
    asView.add(a.name);
    colKeeps.push({ master: best.master, col: best.disc });
  }

  // Ensure each view's discriminator survives as a real column on its master so
  // the view's WHERE clause has a column to filter on (inferSchema may have
  // consumed it into a dimension).
  for (const { master, col } of colKeeps) {
    const masterEntity = plan.entities.find((e) => e.name === master.name);
    if (!masterEntity || masterEntity.columns.some((c) => c.name === col)) continue;
    masterEntity.columns.push({
      name: col,
      sourceKey: master.colSource.get(col) ?? col,
      type: inferFieldType(master.normRows.map((r) => r[col])),
    });
  }

  if (views.length === 0) return { plan, views };

  const nextPlan: ProposedSchema = {
    entities: plan.entities.filter((e) => !asView.has(e.name)),
    linkages: plan.linkages.filter((l) => !asView.has(l.fromEntity)),
    dimensions: plan.dimensions
      .map((d) => ({ ...d, fromEntities: d.fromEntities.filter((n) => !asView.has(n)) }))
      .filter((d) => d.fromEntities.length > 0),
    skipped: plan.skipped,
  };
  return { plan: nextPlan, views };
}
