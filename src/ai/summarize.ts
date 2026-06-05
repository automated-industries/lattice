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
    out.push({ entity, isNew: o.isNew === true, columns, values, label });
    if (out.length >= 3) break;
  }
  return out;
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
  const turn = await client.runTurn({
    model: DEFAULT_MODEL,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `# Existing entities\n${buildSchemaBlock(existing)}\n\n# Document: ${name}\n\n` +
          `${text.slice(0, 12000)}\n\n# Task\nReturn the JSON array of objects to create.`,
      },
    ],
    tools: [],
    ...(temperature !== undefined ? { temperature } : {}),
    onText: () => undefined,
  });
  return parseObjects(turn.text);
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
