/**
 * Detect a per-row "as of" DATE COLUMN — so one file can carry many periods
 * (each row dated by its own column value) instead of a single file-level
 * snapshot date. Like {@link detectAsOfCandidates}, this is a *suggestion* layer:
 * ranked candidates with evidence; the user confirms or declines. Picking one
 * makes the import stamp each row's `as_of` from that column (see
 * `materializeImport`'s `asOfColumn` option) rather than one date for the file.
 */

import { sourceRecords } from './infer.js';
import { parseCellDate } from './asof.js';
import type { ProposedSchema } from './types.js';

export interface AsOfColumnCandidate {
  /** Entity (table) the column lives on. */
  entity: string;
  /** Normalized column name (matches an entity's {@link InferredColumn} `name`). */
  column: string;
  /** 0..1 — higher wins. */
  confidence: number;
  /** Distinct dates seen (>1 ⇒ genuinely multiple periods in one file). */
  distinctDates: number;
  /** Human-readable justification, shown next to the option. */
  evidence: string;
}

// A column NAME that names a snapshot/report date (strong) vs. a generic
// date-ish name (weak). A date-valued column whose name matches neither (e.g.
// "founded", "close_date") is NOT offered — picking the wrong column silently
// mis-dates every row, so we only suggest names that plausibly mean "as of".
const STRONG_NAME =
  /(as[_ -]?of|as[_ -]?at|report(?:ing)?[_ -]?date|valuation[_ -]?date|effective[_ -]?date|period[_ -]?end|snapshot[_ -]?date|statement[_ -]?date|fye)/i;
const WEAK_NAME = /(^|_)(date|period|quarter|asof)($|_)/i;

export function detectAsOfColumns(
  data: Record<string, unknown>,
  plan: ProposedSchema,
): AsOfColumnCandidate[] {
  const out: AsOfColumnCandidate[] = [];
  for (const entity of plan.entities) {
    const records = sourceRecords(data, entity);
    if (records.length < 2) continue;
    for (const col of entity.columns) {
      const strong = STRONG_NAME.test(col.name);
      const weak = WEAK_NAME.test(col.name);
      if (!strong && !weak) continue; // a date column with a non-as-of name isn't suggested
      const vals = records
        .map((r) => r[col.sourceKey])
        .filter((v) => v !== null && v !== undefined && v !== '');
      // Trust it as the row's date only if it's mostly populated AND mostly dates.
      if (vals.length < Math.max(3, Math.floor(records.length * 0.5))) continue;
      const dates = vals.map(parseCellDate).filter((d): d is string => d !== null);
      if (dates.length / vals.length < 0.8) continue;
      const distinctDates = new Set(dates).size;
      const typed = col.type === 'date' || col.type === 'datetime';
      let confidence = strong ? 0.9 : 0.6;
      if (typed) confidence += 0.03;
      if (distinctDates > 1) confidence += 0.04; // multiple periods ⇒ per-row genuinely useful
      out.push({
        entity: entity.name,
        column: col.name,
        confidence: Math.min(confidence, 0.97),
        distinctDates,
        evidence: `column "${col.name}" — ${String(distinctDates)} distinct date${distinctDates === 1 ? '' : 's'} across ${String(vals.length)} rows`,
      });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
