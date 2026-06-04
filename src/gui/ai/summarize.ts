import type { LlmClient } from './chat.js';
import { DEFAULT_MODEL } from './chat.js';

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
