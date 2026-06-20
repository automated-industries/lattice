/**
 * "As of" (snapshot date) detection for an import. The date drives how dated
 * snapshots are kept, so detection is deliberately a *suggestion* layer: many
 * signals each produce a ranked {@link AsOfCandidate} with evidence, the best is
 * prefilled, and the user confirms or overrides. Worst case (no signal) is a
 * blank field — never a silent wrong guess.
 *
 * Signals, strongest first:
 *   - in-content phrase ("as of <date>", "period ended <date>") — the document says it
 *   - in-content bare date (a date in the title/preamble or extracted text)
 *   - file name date ("… 3.31.26.xlsx")
 * Each is file-type-agnostic: a caller feeds text snippets (Excel preamble, JSON
 * meta, extracted PDF text, …) + the file name, and the scanner does the rest.
 */

export interface AsOfCandidate {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Where it came from (for the UI + ranking). */
  source: 'content' | 'filename' | 'column' | 'metadata' | 'llm';
  /** 0..1 — higher wins. */
  confidence: number;
  /** Human-readable justification, shown next to the prefilled field. */
  evidence: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// Phrases that, near a date, strongly imply it's THE snapshot date.
const ASOF_KEYWORDS = /\b(as[ -]?of|as at|period (?:end(?:ed|ing)?|of)|fye|fiscal year end(?:ed|ing)?|year[ -]?end(?:ed|ing)?|quarter[ -]?end(?:ed|ing)?|valuation date|report(?:ing)? date|effective date|dated)\b/i;

function isoFrom(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 2010 || y > 2099) return null; // plausible business range; rejects e.g. a "2.2.4" doc number
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A matched date + the substring it came from, so callers can weigh context. */
interface RawHit {
  date: string;
  match: string;
  index: number;
}

/** Find every parseable date in a string (ISO, US M/D/Y, and long "Month D, Y"). */
function findDates(text: string): RawHit[] {
  const hits: RawHit[] = [];
  const push = (date: string | null, match: string, index: number): void => {
    if (date) hits.push({ date, match, index });
  };
  // ISO 2026-03-31
  for (const m of text.matchAll(/(20\d{2})[-._/](\d{1,2})[-._/](\d{1,2})/g)) {
    push(isoFrom(Number(m[1]), Number(m[2]), Number(m[3])), m[0], m.index);
  }
  // US 3/31/26, 3.31.2026, 3-31-26
  for (const m of text.matchAll(/(\d{1,2})[-._/](\d{1,2})[-._/](\d{2,4})/g)) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    push(isoFrom(y, Number(m[1]), Number(m[2])), m[0], m.index);
  }
  // Long: March 31, 2026  /  Mar 31 2026  /  31 March 2026
  for (const m of text.matchAll(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/g,
  )) {
    const mon = MONTHS[(m[1] ?? '').toLowerCase()];
    if (mon) push(isoFrom(Number(m[3]), mon, Number(m[2])), m[0], m.index);
  }
  for (const m of text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})/g)) {
    const mon = MONTHS[(m[2] ?? '').toLowerCase()];
    if (mon) push(isoFrom(Number(m[3]), mon, Number(m[1])), m[0], m.index);
  }
  return hits;
}

/**
 * Parse a single cell/field value into an ISO date, or null. Handles a `Date`
 * (exceljs hands back `Date` objects for date-typed cells) and date-bearing
 * strings ("2026-03-31", "3/31/26", "March 31, 2026"). Used to read a per-row
 * "as of" column. A bare number is ignored — an Excel serial is already a `Date`
 * by the time we see it, and a loose number is far more likely an amount.
 */
export function parseCellDate(value: unknown): string | null {
  if (value instanceof Date) {
    // exceljs gives UTC-midnight dates — read in UTC so the day doesn't shift.
    return isoFrom(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'string') return findDates(value)[0]?.date ?? null;
  return null;
}

/** Scan free text (a title row, preamble, extracted PDF text, …) for date candidates. */
export function scanText(text: string, label: string): AsOfCandidate[] {
  if (!text) return [];
  const out: AsOfCandidate[] = [];
  for (const hit of findDates(text)) {
    // A keyword within ~40 chars before the date marks it as the as-of date.
    const before = text.slice(Math.max(0, hit.index - 40), hit.index);
    const keyworded = ASOF_KEYWORDS.test(before) || ASOF_KEYWORDS.test(hit.match);
    const snippet = text
      .slice(Math.max(0, hit.index - 24), hit.index + hit.match.length + 4)
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      date: hit.date,
      source: 'content',
      confidence: keyworded ? 0.95 : 0.7,
      evidence: `${label}: "${snippet}"`,
    });
  }
  return out;
}

/** Scan a file name for a date (a useful hint, but weaker than in-content). */
export function scanFilename(fileName: string): AsOfCandidate[] {
  if (!fileName) return [];
  const base = fileName.replace(/\.[A-Za-z0-9]+$/, '');
  // The snapshot date is conventionally near the end, so later matches rank higher.
  return findDates(base).map((hit, i, all) => ({
    date: hit.date,
    source: 'filename' as const,
    confidence: i === all.length - 1 ? 0.6 : 0.45,
    evidence: `file name: "${hit.match}"`,
  }));
}

export interface AsOfInputs {
  fileName?: string;
  /** Text snippets to scan, each with a label (e.g. "title", "extracted text"). */
  texts?: { label: string; text: string }[];
}

/** Gather + rank as-of candidates from all inputs (best first, deduped by date). */
export function detectAsOfCandidates(inputs: AsOfInputs): AsOfCandidate[] {
  const all: AsOfCandidate[] = [];
  for (const t of inputs.texts ?? []) all.push(...scanText(t.text, t.label));
  if (inputs.fileName) all.push(...scanFilename(inputs.fileName));
  // Keep the strongest candidate per distinct date.
  const byDate = new Map<string, AsOfCandidate>();
  for (const c of all) {
    const prev = byDate.get(c.date);
    if (!prev || c.confidence > prev.confidence) byDate.set(c.date, c);
  }
  return [...byDate.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Convenience: the single best-guess date from a file name, or null. */
export function detectAsOf(fileName: string): string | null {
  return scanFilename(fileName)[0]?.date ?? null;
}
