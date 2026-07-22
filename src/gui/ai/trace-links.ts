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
  /** Snapshot of the row's text fields (capped), for source-field detection:
   *  when the answer quotes a field, the link carries `?f=<column>` so the
   *  record view can highlight the actual source data on arrival. */
  fields?: Record<string, string>;
}

/** A focused (single-row) read — the record an answer is ABOUT. Carries its
 *  label so it can be cited even when the answer never names it. */
export interface FocusedRef extends TraceRef {
  label: string;
}

/** Field-snapshot caps: values below MIN can't anchor a quote match; caps keep
 *  a wide row from bloating the maps. */
const FIELD_VALUE_MIN = 30;
const FIELD_VALUE_MAX = 4000;
const FIELDS_PER_REF_MAX = 12;

/** Capture the row's quotable text fields (long string values). */
function fieldsOf(row: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (n >= FIELDS_PER_REF_MAX) break;
    if (k === 'id' || k.endsWith('_id') || k.endsWith('_at')) continue;
    if (typeof v !== 'string' || v.length < FIELD_VALUE_MIN) continue;
    out[k] = v.slice(0, FIELD_VALUE_MAX);
    n++;
  }
  return n > 0 ? out : undefined;
}

/** Parse `- **col:** value` field lines out of a rendered self file. */
function fieldsFromContextFiles(result: unknown): Record<string, string> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const files = (result as Record<string, unknown>).files;
  if (!Array.isArray(files)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const f of files) {
    const content = f && typeof f === 'object' ? (f as Record<string, unknown>).content : null;
    if (typeof content !== 'string' || !content) continue;
    for (const m of content.matchAll(/^-\s+\*\*(\w+):\*\*\s+(.+)$/gm)) {
      if (n >= FIELDS_PER_REF_MAX) break;
      const col = m[1] ?? '';
      const val = (m[2] ?? '').trim();
      if (!col || val.length < FIELD_VALUE_MIN) continue;
      if (!(col in out)) {
        out[col] = val.slice(0, FIELD_VALUE_MAX);
        n++;
      }
    }
  }
  return n > 0 ? out : undefined;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The field the answer actually drew on: the first field whose value shares an
 * 8-word run with the answer (near-verbatim quoting). A paraphrase with no
 * shared run matches nothing — better no highlight than a wrong one.
 */
export function bestSourceField(answerText: string, ref: TraceRef): string {
  if (!ref.fields) return '';
  const answer = normalize(answerText);
  let best = '';
  let bestLen = 0;
  for (const [col, val] of Object.entries(ref.fields)) {
    const words = normalize(val).split(' ');
    if (words.length < 8) continue;
    for (let i = 0; i + 8 <= words.length; i += 4) {
      const shingle = words.slice(i, i + 8).join(' ');
      if (answer.includes(shingle)) {
        if (val.length > bestLen) {
          best = col;
          bestLen = val.length;
        }
        break;
      }
    }
  }
  return best;
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
 * A rendered-context result (`get_row_context` → `{ files }`) carries no row
 * object, but its self file's H1 is the row's display label — recover it so the
 * assistant's PREFERRED read tool still yields a linkable.
 */
function labelFromContextFiles(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const files = (result as Record<string, unknown>).files;
  if (!Array.isArray(files)) return '';
  for (const f of files) {
    const content = f && typeof f === 'object' ? (f as Record<string, unknown>).content : null;
    if (typeof content !== 'string' || !content) continue;
    const h1 = /^#\s+(.+?)\s*$/m.exec(content);
    if (h1?.[1]) return h1[1].trim();
  }
  return '';
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
  focused?: Map<string, FocusedRef>,
): void {
  const table =
    input &&
    typeof input === 'object' &&
    typeof (input as Record<string, unknown>).table === 'string'
      ? ((input as Record<string, unknown>).table as string)
      : '';
  if (!table) return;
  const add = (label: string, id: string, fields?: Record<string, string>): void => {
    if (!label || !id || !eligibleLabel(label)) return;
    const existing = linkables.get(label);
    if (existing === null) return; // already poisoned
    if (existing) {
      if (existing.table !== table || existing.id !== id) linkables.set(label, null);
      return;
    }
    if (linkables.size < MAX_LINKABLES) {
      linkables.set(label, { table, id, ...(fields ? { fields } : {}) });
    }
  };
  // A single-row read (get_row / get_row_context) is FOCUSED — the record the
  // answer is about — and gets remembered for the Sources citation even when
  // the answer never names it. Multi-row (browse) results only feed labels.
  const focus = (label: string, id: string, fields?: Record<string, string>): void => {
    if (focused && label && id && !focused.has(`${table}/${id}`)) {
      focused.set(`${table}/${id}`, { table, id, label, ...(fields ? { fields } : {}) });
    }
  };
  const rows = candidateRows(result);
  const isBrowse = Array.isArray((result as Record<string, unknown>).rows);
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id) {
      const rowFields = fieldsOf(row);
      add(labelOf(row), row.id, rowFields);
      if (!isBrowse) focus(labelOf(row), row.id, rowFields);
    }
  }
  // get_row_context: the input names the row (table + id); its label comes from
  // the rendered self file's H1, its quotable fields from the field lines.
  const inputId = (input as Record<string, unknown>).id;
  if (typeof inputId === 'string' && inputId) {
    const h1 = labelFromContextFiles(result);
    const ctxFields = fieldsFromContextFiles(result);
    add(h1, inputId, ctxFields);
    focus(h1, inputId, ctxFields);
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Run one replace pass over the text's unprotected regions (outside existing
 *  markdown links and inline code — re-split each pass so links inserted by an
 *  earlier pass are never re-matched). */
function replaceOutsideProtected(text: string, replace: (seg: string) => string): string {
  return text
    .split(/(\[[^\]]*\]\([^)]*\)|`[^`]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : replace(seg)))
    .join('');
}

/** A label distinctive enough for case-insensitive matching: multi-word or
 *  long. A short single word ("Review") stays exact-case only — linking every
 *  lowercase "review" in prose would be noise. */
const caseInsensitiveEligible = (label: string): boolean =>
  label.includes(' ') || label.length >= 12;

/**
 * Wrap bare occurrences of retrieved-row labels in `[label](lattice://…)`.
 * Existing markdown links and inline code spans are left untouched and matches
 * are word-bounded (no mid-word hits). Two passes: exact-case for every label,
 * then case-insensitive for distinctive labels (prose often lowercases a title
 * mid-sentence) — the matched span keeps its own casing as the link text.
 */
export function applyTraceLinks(text: string, linkables: Map<string, TraceRef | null>): string {
  const entries = [...linkables.entries()].filter((e): e is [string, TraceRef] => e[1] !== null);
  if (!text || entries.length === 0) return text;
  entries.sort((a, b) => b[0].length - a[0].length);
  const byLabel = new Map(entries);
  const wrap = (span: string, ref: TraceRef): string => {
    const f = bestSourceField(text, ref);
    const q = f ? `?f=${encodeURIComponent(f)}` : '';
    return `[${span}](lattice://${ref.table}/${encodeURIComponent(ref.id)}${q})`;
  };

  const alternation = entries.map(([label]) => escapeRegExp(label)).join('|');
  const exact = new RegExp(`(?<![\\w])(?:${alternation})(?![\\w])`, 'g');
  let out = replaceOutsideProtected(text, (seg) =>
    seg.replace(exact, (label) => {
      const ref = byLabel.get(label);
      return ref ? wrap(label, ref) : label;
    }),
  );

  // Case-insensitive pass for distinctive labels, with case-fold collisions
  // poisoned (two labels differing only in case must not cross-link).
  const folded = new Map<string, TraceRef | null>();
  for (const [label, ref] of entries) {
    if (!caseInsensitiveEligible(label)) continue;
    const key = label.toLowerCase();
    const seen = folded.get(key);
    if (seen === undefined) folded.set(key, ref);
    else if (seen?.table !== ref.table || seen.id !== ref.id) folded.set(key, null);
  }
  const ciLabels = [...folded.keys()];
  if (ciLabels.length > 0) {
    const ci = new RegExp(`(?<![\\w])(?:${ciLabels.map(escapeRegExp).join('|')})(?![\\w])`, 'gi');
    out = replaceOutsideProtected(out, (seg) =>
      seg.replace(ci, (span) => {
        const ref = folded.get(span.toLowerCase());
        return ref ? wrap(span, ref) : span;
      }),
    );
  }
  return out;
}

/**
 * Append a "Sources:" citation line for focused reads the answer never
 * referenced — an answer that paraphrases a record without naming it (so no
 * text match is possible) still ends with a clickable trail to what was read.
 * Refs already present as links (from the model or the linkify passes) are
 * skipped; capped so a busy turn cannot grow a footer of noise.
 */
/**
 * Relevance of a focused ref to the answer: the fraction of the label's
 * distinctive words (≥ 6 chars) present in the answer, plus a strong boost when
 * a field of the row is quoted. Zero-relevance refs are never cited — a turn
 * that touched many records must not footer an answer with unrelated ones.
 */
function sourceRelevance(text: string, answerNorm: string, ref: FocusedRef): number {
  const words = normalize(ref.label)
    .split(' ')
    .filter((w) => w.length >= 6);
  const matched = words.filter((w) => answerNorm.includes(w)).length;
  // Long labels: at least two distinctive words matched. Short labels (fewer
  // than two distinctive words): all of them matched.
  const enough = matched >= 2 || (words.length > 0 && matched === words.length);
  const labelScore = enough ? matched / words.length : 0;
  const quoted = bestSourceField(text, ref) ? 1 : 0;
  return labelScore >= 0.5 || quoted ? labelScore + quoted : 0;
}

export function appendSources(text: string, focused: Map<string, FocusedRef>, max = 3): string {
  if (!text || focused.size === 0) return text;
  const answerNorm = normalize(text);
  const missing = [...focused.values()]
    .filter((f) => f.label && !text.includes(`lattice://${f.table}/${encodeURIComponent(f.id)}`))
    .map((f) => ({ f, score: sourceRelevance(text, answerNorm, f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.f);
  if (missing.length === 0) return text;
  const line = missing
    .map((f) => {
      const col = bestSourceField(text, f);
      const q = col ? `?f=${encodeURIComponent(col)}` : '';
      return `[${f.label}](lattice://${f.table}/${encodeURIComponent(f.id)}${q})`;
    })
    .join(', ');
  return `${text}\n\nSources: ${line}`;
}

/**
 * Backfill field snapshots for focused refs that lack them (history-harvested
 * links carry only label/table/id). Bounded: at most `max` single-row reads,
 * and only for refs whose label is already relevant to the answer — this is
 * what lets a Sources citation for an answer-from-memory still carry the
 * `?f=<column>` source-field highlight. Best-effort; a failed read skips.
 */
export async function snapshotMissingFields(
  getRow: (table: string, id: string) => Promise<Record<string, unknown> | null>,
  answerText: string,
  focused: Map<string, FocusedRef>,
  max = 5,
): Promise<void> {
  const answerNorm = normalize(answerText);
  // A small focused set is snapshotted unconditionally (still ≤ max reads);
  // only a large one applies the label-relevance pre-filter — a possessive or
  // initialism-style label ("...'s DBQ") has no long words to match on, and
  // must not lose its quote-detection over that.
  const preFilter = focused.size > 8;
  let reads = 0;
  for (const ref of focused.values()) {
    if (reads >= max) break;
    if (ref.fields) continue;
    if (preFilter) {
      const words = normalize(ref.label)
        .split(' ')
        .filter((w) => w.length >= 6);
      if (words.filter((w) => answerNorm.includes(w)).length < 2) continue;
    }
    reads++;
    try {
      const row = await getRow(ref.table, ref.id);
      if (row) {
        const fields = fieldsOf(row);
        if (fields) ref.fields = fields;
      }
    } catch {
      // unreadable row — the citation still links, just without a field target
    }
  }
}

const MARKDOWN_LINK = /\[([^\]]+)\]\(lattice:\/\/([a-zA-Z0-9_]+)\/([^)\s]+)\)/g;

/**
 * Add `?f=<column>` to EXISTING lattice:// links (model-emitted or replayed)
 * whose row has a field the answer quotes — the linkify passes never touch an
 * existing link, so field targeting must be grafted on separately. Links that
 * already carry a query, or whose ref/quote is unknown, pass through unchanged.
 */
export function enrichExistingLinks(text: string, focused: Map<string, FocusedRef>): string {
  if (!text || focused.size === 0) return text;
  return text.replace(MARKDOWN_LINK, (whole, label: string, table: string, idRaw: string) => {
    if (idRaw.includes('?')) return whole;
    let id = idRaw;
    try {
      id = decodeURIComponent(idRaw);
    } catch {
      // malformed escape — match on the raw id
    }
    const ref = focused.get(`${table}/${id}`);
    if (!ref?.fields) return whole;
    const col = bestSourceField(text, ref);
    if (!col) return whole;
    return `[${label}](lattice://${table}/${idRaw}?f=${encodeURIComponent(col)})`;
  });
}

/**
 * Harvest linkables from `lattice://` links in PRIOR assistant text (replayed
 * history). Once a record has been linked once in a thread, a later answer that
 * paraphrases it from memory — with no new tool reads — can still match it
 * inline or cite it in Sources. Same ambiguity poisoning as tool harvesting.
 */
export function collectFromMarkdown(
  text: string,
  linkables: Map<string, TraceRef | null>,
  focused?: Map<string, FocusedRef>,
): void {
  if (!text) return;
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const label = (m[1] ?? '').trim();
    const table = m[2] ?? '';
    // Strip a `?f=<column>` source-field query — the id is the part before it.
    let id = (m[3] ?? '').split('?')[0] ?? '';
    try {
      id = decodeURIComponent(id);
    } catch {
      // a malformed escape sequence — keep the raw id
    }
    if (!label || !table || !id || !eligibleLabel(label)) continue;
    const existing = linkables.get(label);
    if (existing === undefined && linkables.size < MAX_LINKABLES) {
      linkables.set(label, { table, id });
    } else if (existing && (existing.table !== table || existing.id !== id)) {
      linkables.set(label, null);
    }
    if (focused && !focused.has(`${table}/${id}`)) {
      focused.set(`${table}/${id}`, { table, id, label });
    }
  }
}
