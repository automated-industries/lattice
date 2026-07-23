import type { LlmClient } from './llm-client.js';
import { DEFAULT_MODEL } from './llm-client.js';

/**
 * One-shot helpers that reuse the chat {@link LlmClient} (no streaming, no
 * tools) to enrich ingested files: a short description, and a classifier that
 * proposes which existing records a document relates to. Both degrade to safe
 * defaults at the call site when no Claude token is configured.
 */

const SUMMARY_SYSTEM =
  'You write a one or two sentence factual description of a document for a ' +
  'knowledge base, focused on what it is and what it contains. No preamble, ' +
  'no "This document". Plain text only.';

/** Generate a 1-2 sentence description of a document's text. */
export async function summarizeText(
  client: LlmClient,
  text: string,
  name: string,
): Promise<string> {
  const turn = await client.runTurn({
    model: DEFAULT_MODEL,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `File name: ${name}\n\nContent:\n${text.slice(0, 12000)}\n\nDescribe it in 1-2 sentences.`,
      },
    ],
    tools: [],
    onText: () => undefined,
  });
  return turn.text.trim();
}

/** A candidate record an ingested file might relate to. */
export interface CatalogRecord {
  id: string;
  label: string;
}
export interface CatalogEntity {
  table: string;
  description?: string;
  records: CatalogRecord[];
}
export interface ClassifyMatch {
  table: string;
  id: string;
}

const CLASSIFY_SYSTEM =
  'You decide which existing records a newly added document relates to. You ' +
  'are given a catalog of record types (with descriptions) and their records. ' +
  'Return ONLY a JSON array of {"table","id"} objects for records the document ' +
  'clearly relates to — an empty array if none. Output the JSON in a ```json ' +
  'fenced block and nothing else.';

function buildCatalogBlock(catalog: CatalogEntity[]): string {
  return catalog
    .map((e) => {
      const head = `## ${e.table}${e.description ? ` — ${e.description}` : ''}`;
      const rows = e.records.map((r) => `- id=${r.id} | ${r.label}`).join('\n');
      return `${head}\n${rows || '- (no records)'}`;
    })
    .join('\n\n');
}

/** Extract the first ```json fenced block (or a bare array) and parse it. */
export function parseMatches(raw: string, catalog: CatalogEntity[]): ClassifyMatch[] {
  const fence = /```json\s*([\s\S]*?)```/i.exec(raw);
  const body = fence ? fence[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse((body ?? '').trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const valid = new Map(catalog.map((e) => [e.table, new Set(e.records.map((r) => r.id))]));
  const out: ClassifyMatch[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const table = (item as { table?: unknown }).table;
    const id = (item as { id?: unknown }).id;
    if (typeof table === 'string' && typeof id === 'string' && valid.get(table)?.has(id)) {
      out.push({ table, id });
    }
  }
  return out;
}

// ── Object extraction: build structured objects from a document ─────────────

/** An existing entity the extractor may reuse: its name + column names. */
export interface SchemaEntity {
  table: string;
  columns: string[];
}

/** A structured object the document represents, to create + link the file to. */
export interface ExtractedObject {
  /** Target entity (snake_case). May be new — see {@link isNew}. */
  entity: string;
  /** True when {@link entity} should be created (it isn't in the schema yet). */
  isNew: boolean;
  /** Columns for a new entity (snake_case); ignored when reusing one. */
  columns: string[];
  /** Column → value for the row to create. */
  values: Record<string, string>;
  /** Short human label for the object. */
  label: string;
  /**
   * The model's 0-1 confidence in its target-entity decision (that {@link entity}
   * is where these records belong / that a new entity is warranted). Optional:
   * a model that omits it is treated by consumers as fully confident (1.0), so
   * pre-confidence outputs behave exactly as before.
   */
  confidence?: number;
  /**
   * Labels of the OTHER extracted objects in the same document this object is
   * related to — e.g. a meeting lists its attendees' labels. Consumers materialize
   * these as record-to-record links (so a meeting links to its people, not just to
   * the source). Optional: absent/empty → no cross-object links.
   */
  links?: string[];
}

const ID_RE = /^[a-z][a-z0-9_]*$/;
const RESERVED_COLS = new Set(['id', 'deleted_at', 'created_at', 'updated_at']);

const EXTRACT_SYSTEM =
  'You build a knowledge base by extracting the key structured objects a document ' +
  'is ABOUT — e.g. an invoice, a person, a project, a contract, a meeting. You are ' +
  'given the existing entity types (tables) and their columns. For each salient ' +
  'object: reuse an existing entity when one clearly fits; otherwise propose a NEW ' +
  'entity with a short snake_case PLURAL name and 2-6 simple snake_case columns. ' +
  'Extract only objects the document is genuinely about — prefer 1-3, never more ' +
  'than 3, and never invent data not in the document. Return ONLY a JSON array of ' +
  'objects {"entity","isNew","columns","values","label"}, where "values" is an ' +
  'OBJECT mapping each column name to its value — e.g. ' +
  '{"invoice_number":"INV-114","total":"6400"} — in a ```json fenced block.';

function buildSchemaBlock(existing: SchemaEntity[]): string {
  if (existing.length === 0) return '(no entities yet — propose new ones)';
  return existing.map((e) => `## ${e.table}\ncolumns: ${e.columns.join(', ')}`).join('\n\n');
}

/** Parse + sanitize the extractor's JSON. Caps at 3 objects; drops invalid ones. */
export function parseObjects(raw: string): ExtractedObject[] {
  const fence = /```json\s*([\s\S]*?)```/i.exec(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse((fence ? fence[1] : raw)?.trim() ?? '');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedObject[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const entity = typeof o.entity === 'string' ? o.entity.trim().toLowerCase() : '';
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!ID_RE.test(entity) || !label) continue;
    // `values` may be an object {col: val} OR a parallel array aligned to
    // `columns` (some models emit the latter despite the prompt) — normalize.
    let valuesRaw: Record<string, unknown> = {};
    if (Array.isArray(o.values) && Array.isArray(o.columns)) {
      o.columns.forEach((c, i) => {
        valuesRaw[String(c)] = (o.values as unknown[])[i];
      });
    } else if (o.values && typeof o.values === 'object') {
      valuesRaw = o.values as Record<string, unknown>;
    }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(valuesRaw)) {
      const col = k.trim().toLowerCase();
      if (
        ID_RE.test(col) &&
        !RESERVED_COLS.has(col) &&
        (typeof v === 'string' || typeof v === 'number')
      ) {
        values[col] = String(v).slice(0, 2000);
      }
    }
    if (Object.keys(values).length === 0) continue;
    const cols = Array.isArray(o.columns)
      ? o.columns
          .map((c) => String(c).trim().toLowerCase())
          .filter((c) => ID_RE.test(c) && !RESERVED_COLS.has(c))
      : [];
    // A new entity's columns must at least cover the value keys.
    const columns = Array.from(new Set([...cols, ...Object.keys(values)])).slice(0, 8);
    // Optional target-entity confidence: kept only when it's a real number,
    // clamped into [0, 1]. Absent/invalid → omitted (consumers treat as 1.0).
    const conf =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : undefined;
    // Related-object labels (this object relates to those others in the same doc).
    // Keep only non-empty strings; cap so a runaway model can't balloon the payload.
    const links = Array.isArray(o.links)
      ? o.links
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim())
          .slice(0, 12)
      : [];
    out.push({
      entity,
      isNew: o.isNew === true,
      columns,
      values,
      label,
      ...(conf !== undefined ? { confidence: conf } : {}),
      ...(links.length > 0 ? { links } : {}),
    });
    if (out.length >= 3) break;
  }
  return out;
}

// ── Full-document extraction: chunk → per-window extract → merge ──────────────
// The model only sees ~12k chars per call, so an oversized document used to be
// truncated to its first window. Instead scan it in a bounded set of overlapping
// windows and merge the results, so objects past the first 12k are still found.

/** Chars the model sees per extraction call (matches documentBlock's clamp). */
export const EXTRACTION_WINDOW = 12000;
/** Window step — a 1k overlap so an object straddling a boundary is seen whole. */
const EXTRACTION_STEP = 11000;
/** Hard cap on extraction round-trips for one document (bounds cost + latency). */
const EXTRACTION_MAX_WINDOWS = 6;

/**
 * Split a document into the fixed windows the object extractor scans. A document
 * within one window returns `[text]` (byte-identical to the pre-chunking path);
 * a larger one returns up to {@link EXTRACTION_MAX_WINDOWS} overlapping windows.
 */
export function chunkTextForExtraction(text: string): string[] {
  if (text.length <= EXTRACTION_WINDOW) return [text];
  const chunks: string[] = [];
  for (
    let start = 0;
    start < text.length && chunks.length < EXTRACTION_MAX_WINDOWS;
    start += EXTRACTION_STEP
  ) {
    chunks.push(text.slice(start, start + EXTRACTION_WINDOW));
  }
  return chunks;
}

/** Chars actually scanned for objects given the window budget. */
export function extractionScannedChars(len: number): number {
  if (len <= EXTRACTION_WINDOW) return len;
  const budget = (EXTRACTION_MAX_WINDOWS - 1) * EXTRACTION_STEP + EXTRACTION_WINDOW;
  return Math.min(len, budget);
}

/**
 * A disclosure note when a document is larger than the extraction window budget,
 * so only a prefix was scanned for structured objects. Null when fully covered
 * (the common case) — the caller surfaces it only when non-null.
 */
export function extractionTruncationNote(name: string, len: number): string | null {
  const scanned = extractionScannedChars(len);
  if (scanned >= len) return null;
  return (
    `Extracted structured objects from the first ${scanned.toLocaleString()} of ` +
    `${len.toLocaleString()} characters of "${name}"; the remainder was indexed ` +
    `but not scanned for objects.`
  );
}

/**
 * Merge the per-window extraction results into one deduped list. Keyed by
 * entity + normalized label; the FIRST occurrence wins, and later windows only
 * fill missing value keys and union columns (≤8) / links (≤12). Final list
 * capped at 12. A single group in → the same objects out (small-doc path).
 */
export function mergeExtractedObjects(groups: ExtractedObject[][]): ExtractedObject[] {
  // A single window (a ≤12k document is always exactly one window) is returned
  // verbatim — no dedup/merge — so a small document's output stays byte-identical
  // to the pre-chunking path. The merge exists only to reconcile the overlap seams
  // between multiple windows; running it on one window would silently collapse two
  // same-labeled objects the model returned in a single response.
  if (groups.length <= 1) return groups[0] ?? [];
  const byKey = new Map<string, ExtractedObject>();
  const order: string[] = [];
  for (const group of groups) {
    for (const obj of group) {
      const key = obj.entity + '\0' + obj.label.trim().toLowerCase();
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          ...obj,
          columns: obj.columns.slice(0, 8),
          values: { ...obj.values },
          ...(obj.links ? { links: obj.links.slice(0, 12) } : {}),
        });
        order.push(key);
        continue;
      }
      for (const [k, v] of Object.entries(obj.values)) {
        if (!(k in existing.values)) existing.values[k] = v;
      }
      if (obj.columns.length) {
        const cols = new Set(existing.columns);
        for (const c of obj.columns) if (cols.size < 8) cols.add(c);
        existing.columns = [...cols].slice(0, 8);
      }
      if (obj.links?.length) {
        const links = new Set(existing.links ?? []);
        for (const l of obj.links) if (links.size < 12) links.add(l);
        existing.links = [...links].slice(0, 12);
      }
    }
  }
  const merged: ExtractedObject[] = [];
  for (const k of order) {
    const obj = byKey.get(k);
    if (obj) merged.push(obj);
    if (merged.length >= 12) break;
  }
  return merged;
}

/**
 * Ask the model to extract the structured objects a document represents, given
 * the user's current schema. Reuses existing entities or proposes new ones.
 * Best-effort; returns [] on any failure. The caller decides (by aggressiveness)
 * whether to materialize them and gates new-entity creation.
 */
export async function extractObjects(
  client: LlmClient,
  text: string,
  name: string,
  existing: SchemaEntity[],
  temperature?: number,
): Promise<ExtractedObject[]> {
  if (text.trim().length === 0) return [];
  const groups: ExtractedObject[][] = [];
  for (const chunk of chunkTextForExtraction(text)) {
    const turn = await client.runTurn({
      model: DEFAULT_MODEL,
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `# Existing entities\n${buildSchemaBlock(existing)}\n\n# Document: ${name}\n\n` +
            `${chunk}\n\n# Task\nReturn the JSON array of objects to create.`,
        },
      ],
      tools: [],
      ...(temperature !== undefined ? { temperature } : {}),
      onText: () => undefined,
    });
    groups.push(parseObjects(turn.text));
  }
  return mergeExtractedObjects(groups);
}

/**
 * Ask the model which catalog records the document relates to. Returns only
 * matches that validate against the supplied catalog (no hallucinated ids).
 */
export async function classifyLinks(
  client: LlmClient,
  text: string,
  name: string,
  catalog: CatalogEntity[],
): Promise<ClassifyMatch[]> {
  if (catalog.length === 0 || text.trim().length === 0) return [];
  let captured = '';
  const turn = await client.runTurn({
    model: DEFAULT_MODEL,
    system: CLASSIFY_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `# Catalog\n${buildCatalogBlock(catalog)}\n\n# Document: ${name}\n\n` +
          `${text.slice(0, 12000)}\n\n# Task\nReturn the JSON array of matching {table,id}.`,
      },
    ],
    tools: [],
    onText: (d) => {
      captured += d;
    },
  });
  return parseMatches(turn.text || captured, catalog);
}
