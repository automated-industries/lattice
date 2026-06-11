import type { Lattice } from '../lattice.js';
import type { LlmClient } from './llm-client.js';
import { DEFAULT_MODEL } from './llm-client.js';

/**
 * The enrich pass: when a knowledge object (e.g. a `notes` row the organizer
 * created) has accumulated several linked sources but only a thin body, this
 * synthesizes the sources into a single coherent body and updates the row — but
 * only if the result is genuinely better than what's there. AI-gated: a no-op
 * without an LLM client.
 *
 * It operates over the same generic link table the organizer writes
 * (`file_links`: file_id, table_name, row_id), so it stays schema-agnostic.
 */
export interface EnrichOptions {
  client: LlmClient | null;
  /** Table holding the knowledge objects to enrich. Default `'notes'`. */
  knowledgeTable?: string;
  /** Column on the knowledge object holding its prose body. Default `'body'`. */
  bodyColumn?: string;
  /** Generic (file → row) link table. Default `'file_links'`. */
  linkTable?: string;
  /** Table holding the source files. Default `'files'`. */
  sourceTable?: string;
  /** Column on the source table holding extracted text. Default `'extracted_text'`. */
  sourceTextColumn?: string;
  /** Minimum linked sources before an object is eligible. Default `2`. */
  minSources?: number;
  /** A body shorter than this many chars is considered "thin". Default `500`. */
  thinBodyChars?: number;
  /** Cap on objects enriched per pass. Default `40`. */
  maxObjects?: number;
}

export interface EnrichResult {
  /** True when AI was disabled — nothing was examined or written. */
  skipped: boolean;
  /** Ids of knowledge objects whose body was rewritten. */
  enriched: string[];
  /** How many eligible objects were examined. */
  examined: number;
}

const ENRICH_SYSTEM =
  'You are writing the body of a knowledge-base entry by synthesizing several ' +
  'source documents into one coherent, factual summary. Integrate concrete ' +
  'facts (dates, names, amounts) and note relationships across sources. Do not ' +
  'invent anything; if the sources are thin, keep it short. Output ONLY the ' +
  'body markdown — no title, no headings like "Sources", no preamble, no fences.';

export async function enrichKnowledge(db: Lattice, opts: EnrichOptions): Promise<EnrichResult> {
  const { client } = opts;
  if (!client) return { skipped: true, enriched: [], examined: 0 };

  const knowledgeTable = opts.knowledgeTable ?? 'notes';
  const bodyColumn = opts.bodyColumn ?? 'body';
  const linkTable = opts.linkTable ?? 'file_links';
  const sourceTable = opts.sourceTable ?? 'files';
  const sourceTextColumn = opts.sourceTextColumn ?? 'extracted_text';
  const minSources = opts.minSources ?? 2;
  const thinBodyChars = opts.thinBodyChars ?? 500;
  const maxObjects = opts.maxObjects ?? 40;

  const links = await db.query(linkTable);
  const objects = await db.query(knowledgeTable);

  // Index source links by knowledge-object row id in one pass (was an
  // O(objects × links) rescan inside the loop below).
  const sourceIdsByObject = new Map<string, string[]>();
  for (const l of links) {
    if (String(l.table_name) !== knowledgeTable) continue;
    const rowId = String(l.row_id);
    const arr = sourceIdsByObject.get(rowId);
    if (arr) arr.push(String(l.file_id));
    else sourceIdsByObject.set(rowId, [String(l.file_id)]);
  }

  const enriched: string[] = [];
  let examined = 0;

  for (const obj of objects) {
    if (enriched.length >= maxObjects) break;
    const idVal = obj.id;
    const id = typeof idVal === 'string' ? idVal : '';
    if (id.length === 0) continue;

    const sourceIds = sourceIdsByObject.get(id) ?? [];
    if (sourceIds.length < minSources) continue;

    const rawBody = obj[bodyColumn];
    const currentBody = typeof rawBody === 'string' ? rawBody : '';
    if (currentBody.length >= thinBodyChars) continue;

    examined++;
    const snippets: string[] = [];
    for (const sid of sourceIds) {
      const src = await db.get(sourceTable, sid);
      const rawText = src ? src[sourceTextColumn] : '';
      if (typeof rawText === 'string' && rawText.trim().length > 0) {
        snippets.push(rawText.slice(0, 4000));
      }
    }
    if (snippets.length < minSources) continue;

    const titleVal = obj.title ?? obj.name;
    const title = typeof titleVal === 'string' && titleVal.length > 0 ? titleVal : id;
    const userBlock =
      `# Entry: ${title}\n\nCurrent body:\n${currentBody || '(empty)'}\n\n` +
      snippets.map((s, i) => `## Source ${String(i + 1)}\n${s}`).join('\n\n') +
      `\n\n# Task\nWrite the improved body.`;

    let newBody = '';
    try {
      const turn = await client.runTurn({
        model: DEFAULT_MODEL,
        system: ENRICH_SYSTEM,
        messages: [{ role: 'user', content: userBlock }],
        tools: [],
        onText: () => undefined,
      });
      newBody = turn.text.trim();
    } catch {
      continue; // a single failed synthesis shouldn't abort the pass
    }

    if (isBetter(newBody, currentBody)) {
      // Confused-deputy guard: this body is DERIVED from the source files we just
      // read, so stamp the write with that source-set as provenance instead of
      // discarding it. The change-log then records which sources produced the
      // value — the basis for later per-viewer audience gating + revocation.
      await db.update(
        knowledgeTable,
        id,
        { [bodyColumn]: newBody },
        { sourceRef: sourceIds, changeKind: 'derived' },
      );
      enriched.push(id);
    }
  }

  return { skipped: false, enriched, examined };
}

/** Accept the rewrite only if it is materially better than the current body. */
function isBetter(next: string, prev: string): boolean {
  if (next.length === 0) return false;
  if (prev.trim().length < 40 && next.length > 120) return true; // empty/stub → substantial
  return next.length > prev.length + 80; // meaningfully longer
}
