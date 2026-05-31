import type { Lattice } from '../lattice.js';
import type { LlmClient } from './llm-client.js';
import {
  classifyLinks,
  summarizeText,
  type CatalogEntity,
  type ClassifyMatch,
} from './summarize.js';

/**
 * The context organizer. Given an ingested source (a `files` row's text), it
 * sorts it into the user's OWN schema by default — summarizing it and linking
 * it to the existing records it relates to — and creates a new knowledge
 * object ONLY when nothing in the user's schema fits. Every action is an
 * ordinary, user-editable row, and the result carries a plain-language
 * {@link OrganizeResult.message} the caller can show ("…created a new note…
 * you can change this anytime").
 *
 * AI-gated: with no {@link OrganizeOptions.client} (no key/auth configured),
 * it is a no-op (`skipped: true`) and writes nothing.
 */
export interface OrganizeOptions {
  /** The `files` row id being organized. */
  fileId: string;
  /** Extracted text of the source. */
  text: string;
  /** Original file/source name. */
  name: string;
  /** The user's existing records the source may relate to. */
  catalog: CatalogEntity[];
  /** LLM client. `null` ⇒ AI disabled ⇒ no-op. */
  client: LlmClient | null;
  /**
   * Junction table that records a (file → row) link. Must have columns
   * `file_id`, `table_name`, `row_id`, `relevance`. Default `'file_links'`.
   */
  linkTable?: string;
  /**
   * Table to create a fallback knowledge object in when nothing fits. Must
   * have `title` + `body` columns. Default `'notes'`.
   */
  fallbackTable?: string;
  /** Create a fallback object when nothing was attached. Default `true`. */
  createIfNecessary?: boolean;
  /**
   * Host-supplied linker: attach the file to an existing record and return
   * `true` if a link was actually created. Defaults to inserting into
   * {@link linkTable}. The GUI supplies junction-table linking here.
   */
  linkExisting?: (match: ClassifyMatch) => Promise<boolean>;
  /**
   * Host-supplied fallback creator: create a new knowledge object and return
   * its `{ table, id }`, or `null` to skip creation. Defaults to inserting into
   * {@link fallbackTable}.
   */
  createFallback?: (title: string, body: string) => Promise<{ table: string; id: string } | null>;
}

export interface OrganizedLink {
  table: string;
  id: string;
}
export interface OrganizedCreation {
  table: string;
  id: string;
  title: string;
}
export interface OrganizeResult {
  /** True when AI was disabled (no client) — nothing was written. */
  skipped: boolean;
  /** The 1–2 sentence description (empty when skipped). */
  description: string;
  /** Existing records the source was linked to. */
  linked: OrganizedLink[];
  /** New knowledge objects created because nothing fit. */
  created: OrganizedCreation[];
  /** Plain-language summary for the user (empty when skipped). */
  message: string;
}

export async function organizeSource(db: Lattice, opts: OrganizeOptions): Promise<OrganizeResult> {
  const { fileId, text, name, catalog, client } = opts;
  const linkTable = opts.linkTable ?? 'file_links';
  const fallbackTable = opts.fallbackTable ?? 'notes';
  const createIfNecessary = opts.createIfNecessary ?? true;

  if (!client) {
    return { skipped: true, description: '', linked: [], created: [], message: '' };
  }

  const linkExisting =
    opts.linkExisting ??
    (async (m: ClassifyMatch): Promise<boolean> => {
      await db.insert(linkTable, {
        file_id: fileId,
        table_name: m.table,
        row_id: m.id,
        relevance: 'related',
      });
      return true;
    });
  const createFallback =
    opts.createFallback ??
    (async (title: string, body: string): Promise<{ table: string; id: string }> => {
      const id = await db.insert(fallbackTable, { title, body });
      await db.insert(linkTable, {
        file_id: fileId,
        table_name: fallbackTable,
        row_id: id,
        relevance: 'primary',
      });
      return { table: fallbackTable, id };
    });

  const description = (await summarizeText(client, text, name)).trim();
  const matches = await classifyLinks(client, text, name, catalog);

  const linked: OrganizedLink[] = [];
  for (const m of matches) {
    if (await linkExisting(m)) linked.push({ table: m.table, id: m.id });
  }

  // Create a fallback object only when NOTHING was attached to the user's schema.
  const created: OrganizedCreation[] = [];
  if (linked.length === 0 && createIfNecessary && text.trim().length > 0) {
    const title = name.replace(/\.[^./\\]+$/, '').trim() || 'Note';
    const body = description.length > 0 ? description : text.slice(0, 2000);
    const result = await createFallback(title, body);
    if (result) created.push({ table: result.table, id: result.id, title });
  }

  return {
    skipped: false,
    description,
    linked,
    created,
    message: buildMessage(linked, created),
  };
}

function buildMessage(linked: OrganizedLink[], created: OrganizedCreation[]): string {
  const parts: string[] = [];
  if (linked.length > 0) {
    const byTable = new Map<string, number>();
    for (const l of linked) byTable.set(l.table, (byTable.get(l.table) ?? 0) + 1);
    const where = [...byTable.entries()].map(([t, n]) => `${String(n)} in ${t}`).join(', ');
    parts.push(
      `Linked it to ${String(linked.length)} existing record${linked.length === 1 ? '' : 's'} (${where}).`,
    );
  }
  for (const c of created) {
    parts.push(
      `Created a new ${singular(c.table)} "${c.title}" because it didn't fit any existing record.`,
    );
  }
  if (parts.length === 0) parts.push('Saved it; nothing else needed organizing.');
  parts.push('You can change any of this anytime.');
  return parts.join(' ');
}

function singular(table: string): string {
  if (/ies$/i.test(table)) return table.replace(/ies$/i, 'y');
  if (/s$/i.test(table) && !/ss$/i.test(table)) return table.replace(/s$/i, '');
  return table;
}
