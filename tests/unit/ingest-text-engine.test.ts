import { describe, it, expect, vi, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { getFunction } from '../../src/gui/ai/registry.js';
import { DISPATCHABLE } from '../../src/gui/ai/dispatch.js';

/**
 * The `ingest_text` tool lets the chat assistant route pasted content through the
 * SAME ingestion engine a dropped file uses (ingestTextAsFile → enrichWithLlm),
 * which deterministically links the content to the records it refers to and extracts
 * the objects it describes — instead of hand-creating rows and relying on prompt
 * instructions to link. These pin that the tool is wired and that a text ingest
 * actually creates a file and runs it through enrichWithLlm with FULL enrichment
 * (entity + junction creation enabled, since chat content is user-provided/trusted).
 */

const enrichSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock('../../src/gui/ai/enrich.js', async (orig) => {
  const actual = await orig<typeof import('../../src/gui/ai/enrich.js')>();
  return { ...actual, enrichWithLlm: enrichSpy };
});
import { ingestTextAsFile } from '../../src/gui/ingest-routes.js';

afterEach(() => enrichSpy.mockClear());

describe('ingest_text → shared file-ingest engine', () => {
  it('is a registered, mutating, dispatchable tool', () => {
    const fn = getFunction('ingest_text');
    expect(fn?.mutates).toBe(true);
    expect(DISPATCHABLE.has('ingest_text')).toBe(true);
  });

  it('saves pasted text as a file AND runs enrichWithLlm on it with full enrichment', async () => {
    const db = new Lattice(':memory:', { encryptionKey: 'test-ingest-key' });
    registerNativeEntities(db);
    // The GUI audit table createRow writes to (defined by openConfig in the real app).
    db.define('_lattice_gui_audit', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        table_name: 'TEXT NOT NULL',
        row_id: 'TEXT',
        operation: 'TEXT NOT NULL',
        before_json: 'TEXT',
        after_json: 'TEXT',
        undone: 'INTEGER NOT NULL DEFAULT 0',
      },
      render: () => '',
      outputFile: '.s/audit.md',
    });
    await db.init();
    const mctx = {
      db,
      feed: new FeedBus(),
      softDeletable: new Set(['files']),
      source: 'ai' as const,
    };
    const createEntity = vi.fn(() => Promise.resolve<string | null>(null));
    const createJunction = vi.fn(() => Promise.resolve(null));
    const { id } = await ingestTextAsFile(
      { db, mctx, fileJunctions: [], entityDescriptions: {}, createEntity, createJunction },
      'These are my meeting notes about the Q3 launch.',
      'Meeting notes',
    );

    // A file row was created for the pasted content.
    const files = (await db.query('files', {})) as { id: string; extracted_text?: string }[];
    expect(files.length).toBe(1);
    expect(files[0]?.extracted_text).toContain('Q3 launch');

    // …and it went through the SAME engine a dropped file uses, with entity + junction
    // creation enabled — so the linking is done by the deterministic engine, generically,
    // not by per-object-type prompt rules.
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    const a = enrichSpy.mock.calls[0] as unknown[];
    expect(a[2]).toBe(id); // fileId
    expect(String(a[3])).toContain('Q3 launch'); // the content
    expect(a[7]).toBe(createJunction); // files-side linker (auto-link to existing)
    expect(a[9]).toBe(createEntity); // entity creator (extract → new object)
    db.close();
  });
});
