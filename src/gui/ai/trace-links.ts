/**
 * Deterministic trace-linking for assistant replies.
 *
 * The system prompt asks the model to write retrieved records as
 * `[label](lattice://table/id)` references, but emission is stochastic — and a
 * record name written as plain text is a dead end for tracing. The read-tool
 * results of a turn already carry every row the model actually retrieved, so
 * after the final answer round this module wraps bare occurrences of those
 * rows' labels in the same link form. The chat renderer then turns them into
 * clickable references whether or not the model remembered to link.
 */

export interface TraceRef {
  table: string;
  id: string;
}

/** Row fields tried (in order) for a human-facing label. */
const LABEL_FIELDS = ['name', 'title', 'label', 'number', 'filename', 'original_name'];

/** Hard cap on tracked labels — a runaway list read must not grow this forever. */
const MAX_LINKABLES = 300;

function labelOf(row: Record<string, unknown>): string {
  for (const f of LABEL_FIELDS) {
    const v = row[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * A label worth linking: long enough to not riddle prose with links, and not a
 * short bare number (linking every "42" in an answer would be noise).
 */
function eligibleLabel(label: string): boolean {
  if (label.length < 3 || label.length > 120) return false;
  return /[A-Za-z]/.test(label) || label.length >= 6;
}

function candidateRows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.rows))
    return r.rows.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (r.row && typeof r.row === 'object') return [r.row as Record<string, unknown>];
  if (typeof r.id === 'string') return [r];
  return [];
}

/**
 * Harvest linkable (label → table/id) pairs from one read-tool result. The
 * table comes from the tool's own `table` argument. A label seen with two
 * DIFFERENT targets is poisoned (set to null) — an ambiguous label must never
 * link to the wrong row.
 */
export function collectLinkables(
  input: unknown,
  result: unknown,
  linkables: Map<string, TraceRef | null>,
): void {
  const table =
    input &&
    typeof input === 'object' &&
    typeof (input as Record<string, unknown>).table === 'string'
      ? ((input as Record<string, unknown>).table as string)
      : '';
  if (!table) return;
  for (const row of candidateRows(result)) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) continue;
    const label = labelOf(row);
    if (!label || !eligibleLabel(label)) continue;
    const existing = linkables.get(label);
    if (existing === null) continue; // already poisoned
    if (existing) {
      if (existing.table !== table || existing.id !== id) linkables.set(label, null);
      continue;
    }
    if (linkables.size < MAX_LINKABLES) linkables.set(label, { table, id });
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wrap bare occurrences of retrieved-row labels in `[label](lattice://…)`.
 * Existing markdown links and inline code spans are left untouched, matches are
 * word-bounded (no mid-word hits), and all labels are replaced in ONE pass
 * (longest label wins on overlap) so an inserted link is never re-matched.
 */
export function applyTraceLinks(text: string, linkables: Map<string, TraceRef | null>): string {
  const entries = [...linkables.entries()].filter((e): e is [string, TraceRef] => e[1] !== null);
  if (!text || entries.length === 0) return text;
  entries.sort((a, b) => b[0].length - a[0].length);
  const byLabel = new Map(entries);
  const alternation = entries.map(([label]) => escapeRegExp(label)).join('|');
  const matcher = new RegExp(`(?<![\\w])(?:${alternation})(?![\\w])`, 'g');

  // Split out the already-safe regions (markdown links, inline code) so a label
  // inside an existing link's text or URL is never double-wrapped.
  const segments = text.split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // protected region
      return seg.replace(matcher, (label) => {
        const ref = byLabel.get(label);
        if (!ref) return label;
        return `[${label}](lattice://${ref.table}/${encodeURIComponent(ref.id)})`;
      });
    })
    .join('');
}
