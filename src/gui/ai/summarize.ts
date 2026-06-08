import type { LlmClient } from './chat.js';
import { DEFAULT_MODEL } from './chat.js';
import {
  parseObjects,
  parseMatches,
  type SchemaEntity,
  type ExtractedObject,
  type CatalogEntity,
  type CatalogRecord,
  type ClassifyMatch,
} from '../../ai/summarize.js';

/**
 * GUI-side ingest enrichment helpers (a short description + a record classifier
 * + structured-object extraction). These wrap the GUI chat {@link LlmClient}
 * and add the inference-aggressiveness `temperature` the rail exposes.
 *
 * The PURE, runtime-independent parts — `parseObjects` / `parseMatches` and the
 * shared types — are the library's (`src/ai/summarize.ts`), re-exported here so
 * there's one parser + one set of types, not two copies. Only the LLM-calling
 * functions live here (they take the GUI client type + a temperature param).
 */

export { parseObjects, parseMatches };
export type { SchemaEntity, ExtractedObject, CatalogEntity, CatalogRecord, ClassifyMatch };

const SUMMARY_SYSTEM =
  'You write a one or two sentence factual description of a document for a ' +
  'knowledge base, focused on what it is and what it contains. No preamble, ' +
  'no "This document". Plain text only.';

/** Generate a 1-2 sentence description of a document's text. */
export async function summarizeText(
  client: LlmClient,
  text: string,
  name: string,
  temperature?: number,
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
    ...(temperature !== undefined ? { temperature } : {}),
    onText: () => undefined,
  });
  return turn.text.trim();
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

/**
 * Ask the model which catalog records the document relates to. Returns only
 * matches that validate against the supplied catalog (no hallucinated ids).
 */
export async function classifyLinks(
  client: LlmClient,
  text: string,
  name: string,
  catalog: CatalogEntity[],
  temperature?: number,
): Promise<ClassifyMatch[]> {
  if (catalog.length === 0 || text.trim().length === 0) return [];
  let captured = '';
  // Inference aggressiveness (derived from temperature) tunes how liberally the
  // classifier proposes links: low = only an explicit, unambiguous mention;
  // high = also infer strongly-implied relationships.
  const liberal =
    temperature !== undefined && temperature >= 0.66
      ? ' Include records that are strongly implied even without an exact name match.'
      : temperature !== undefined && temperature <= 0.33
        ? ' Only include records that are explicitly and unambiguously named.'
        : '';
  const turn = await client.runTurn({
    model: DEFAULT_MODEL,
    system: CLASSIFY_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `# Catalog\n${buildCatalogBlock(catalog)}\n\n# Document: ${name}\n\n` +
          `${text.slice(0, 12000)}\n\n# Task\nReturn the JSON array of matching {table,id}.${liberal}`,
      },
    ],
    tools: [],
    ...(temperature !== undefined ? { temperature } : {}),
    onText: (d) => {
      captured += d;
    },
  });
  return parseMatches(turn.text || captured, catalog);
}

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
