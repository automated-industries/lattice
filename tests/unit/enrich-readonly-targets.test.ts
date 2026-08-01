import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { enrichWithLlm } from '../../src/gui/ai/enrich.js';
import type { TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * Ingest must never aim an extracted object at a table it cannot write to.
 *
 * A connected mirror (a local, read-only copy of an external source, replaced
 * wholesale on every sync) and a computed view (a live read-only projection)
 * both refuse row writes at the mutation chokepoint. Previously the enrichment
 * engine offered them to the model as candidate targets anyway, and every write
 * the model then aimed at one was rejected — the rejection landing only on the
 * console, so the upload reported success while the extracted objects vanished.
 *
 * Two guarantees are pinned here:
 *   1. read-only tables are filtered OUT of the catalog + schema the model
 *      chooses from, so the target is never offered in the first place; and
 *   2. any extraction that still cannot be written is REPORTED — on the result
 *      and in the activity feed — instead of being swallowed.
 */

// The fake model answers by PROMPT (summary / classify / extract) rather than by
// call order, and records the prompt text so a test can assert what the model was
// actually shown.
const scripted = vi.hoisted(() => ({
  classifyJson: '```json\n[]\n```',
  extractJson: '```json\n[]\n```',
  prompts: [] as { kind: string; content: string }[],
}));

vi.mock('../../src/gui/ai/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    createAnthropicClient: () => ({
      runTurn(params: TurnParams): Promise<TurnResult> {
        const sys = params.system;
        const first = params.messages[0]?.content;
        const content = typeof first === 'string' ? first : JSON.stringify(first);
        let text = '';
        if (sys.includes('one or two sentence')) {
          scripted.prompts.push({ kind: 'summary', content });
          text = 'A test document.';
        } else if (sys.includes('which existing records')) {
          scripted.prompts.push({ kind: 'classify', content });
          text = scripted.classifyJson;
        } else if (sys.includes('extracting the key structured objects')) {
          scripted.prompts.push({ kind: 'extract', content });
          text = scripted.extractJson;
        }
        return Promise.resolve({ stopReason: 'end_turn', text, toolUses: [] });
      },
    }),
  };
});
vi.mock('../../src/ops/ai-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ops/ai-config.js')>();
  return { ...actual, resolveClaudeAuth: () => Promise.resolve({ apiKey: 'test-key' }) };
});

function fence(objects: unknown[]): string {
  return '```json\n' + JSON.stringify(objects) + '\n```';
}

function promptOf(kind: string): string {
  return scripted.prompts.find((p) => p.kind === kind)?.content ?? '';
}

describe('enrich never targets a read-only table, and never drops an extraction silently', () => {
  let tmpDir: string;
  let cfgDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let feedEvents: FeedEvent[];
  let mctx: MutationCtx;
  let fileId: string;

  const t = (cols: Record<string, string>, out: string) => ({
    columns: cols,
    render: () => '',
    outputFile: out,
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-readonly-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-readonly-cfg-'));
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    scripted.classifyJson = '```json\n[]\n```';
    scripted.extractJson = '```json\n[]\n```';
    scripted.prompts = [];
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define(
      'files',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          original_name: 'TEXT',
          description: 'TEXT',
          extracted_text: 'TEXT',
          deleted_at: 'TEXT',
        },
        '.s/files.md',
      ),
    );
    // An ordinary, writable entity — the control.
    db.define(
      'suppliers',
      t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/suppliers.md'),
    );
    // A connected mirror of an external source: rows are replaced on every sync,
    // so the mutation chokepoint refuses direct writes to it.
    db.define('external_items', {
      columns: {
        item_key: 'TEXT PRIMARY KEY',
        name: 'TEXT',
        deleted_at: 'TEXT',
      },
      primaryKey: 'item_key',
      source: {
        connector: 'generic',
        toolkit: 'generic',
        model: 'item',
        naturalKey: 'item_key',
      },
      render: () => '',
      outputFile: '.s/external_items.md',
    });
    // An ordinary entity carrying a required column the extractor cannot supply,
    // so a write against it is refused by the database itself.
    db.define(
      'purchase_orders',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          name: 'TEXT',
          po_number: 'TEXT NOT NULL',
          deleted_at: 'TEXT',
        },
        '.s/po.md',
      ),
    );
    db.define(
      '_lattice_gui_audit',
      t(
        {
          id: 'TEXT PRIMARY KEY',
          ts: "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          table_name: 'TEXT NOT NULL',
          row_id: 'TEXT',
          operation: 'TEXT NOT NULL',
          before_json: 'TEXT',
          after_json: 'TEXT',
          undone: 'INTEGER NOT NULL DEFAULT 0',
        },
        '.s/audit.md',
      ),
    );
    await db.init();
    fileId = await db.insert('files', { original_name: 'dashboard.html', extracted_text: 'x' });
    // Both tables hold records, so both would otherwise appear in the catalog.
    await db.insert('suppliers', { name: 'Acme Corp' });
    await db.insert('external_items', { item_key: 'EXT-1', name: 'Mirrored Widget' });
    feed = new FeedBus();
    feedEvents = [];
    feed.subscribe((e) => feedEvents.push(e));
    mctx = {
      db,
      feed,
      softDeletable: new Set(['files', 'suppliers']),
      source: 'ingest',
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  // Aggressiveness 0.6: extraction runs (>= 0.4) and new entities are allowed
  // (>= 0.5), while the last-resort capture (>= 0.66) stays out of the way.
  function run(
    createEntity?: (entity: string, columns: string[]) => Promise<string | null>,
  ): ReturnType<typeof enrichWithLlm> {
    return enrichWithLlm(
      mctx,
      db,
      fileId,
      'Quarterly dashboard for Acme Corp.',
      'dashboard.html',
      [], // junctions
      {}, // descriptions
      undefined, // createJunction
      0.6,
      createEntity ?? ((): Promise<string | null> => Promise.resolve(null)),
    );
  }

  it('keeps a connected read-only mirror out of the catalog and the schema the model picks from', async () => {
    await run();
    // Both round-trips actually happened…
    expect(promptOf('classify')).not.toBe('');
    expect(promptOf('extract')).not.toBe('');
    // …and neither offered the read-only mirror as a candidate…
    expect(promptOf('classify')).not.toContain('external_items');
    expect(promptOf('extract')).not.toContain('external_items');
    // …while the ordinary writable entity is still offered (the filter is
    // targeted at read-only tables, not a blanket exclusion).
    expect(promptOf('classify')).toContain('suppliers');
    expect(promptOf('extract')).toContain('suppliers');
  });

  it('keeps a computed read-only view out of the catalog and the schema too', async () => {
    const result = await db.registerComputedTablesLive({
      supplier_view: { base: 'suppliers', fields: { label: { kind: 'alias', source: 'name' } } },
    });
    expect(result.errors).toEqual([]);
    expect(db.isComputedTable('supplier_view')).toBe(true);
    scripted.prompts = [];
    await run();
    expect(promptOf('classify')).not.toContain('supplier_view');
    expect(promptOf('extract')).not.toContain('supplier_view');
    expect(promptOf('extract')).toContain('suppliers');
  });

  it('reports (does not swallow) an extraction aimed at a read-only mirror', async () => {
    scripted.extractJson = fence([
      {
        entity: 'external_items',
        isNew: false,
        columns: ['name'],
        values: { name: 'Mirrored Widget' },
        label: 'Mirrored Widget',
        confidence: 0.95,
      },
    ]);
    // A real entity creator hands back an already-registered table under that
    // name rather than creating a second one — which is how a hallucinated
    // read-only name could still resolve to the mirror.
    const createEntity = vi.fn((entity: string) =>
      Promise.resolve<string | null>(db.getRegisteredTableNames().includes(entity) ? entity : null),
    );
    const out = await run(createEntity);

    // Nothing was written into the mirror…
    const mirrored = (await db.query('external_items', {})) as Record<string, unknown>[];
    expect(mirrored.length).toBe(1);
    // …and the refusal is visible on the result…
    expect(out.dropped.length).toBe(1);
    expect(out.dropped[0]?.entity).toBe('external_items');
    expect(out.dropped[0]?.label).toBe('Mirrored Widget');
    expect(out.dropped[0]?.reason).toBeTruthy();
    // …and in the activity feed, not just the console.
    expect(
      feedEvents.some(
        (e) =>
          (e.summary ?? '').includes('Mirrored Widget') &&
          (e.summary ?? '').includes('external_items'),
      ),
    ).toBe(true);
  });

  it('reports (does not swallow) an extraction the database itself refuses', async () => {
    // `purchase_orders` requires a column the extractor cannot supply, so the
    // insert fails — exactly the class of refusal that used to reach only the
    // console while the upload reported success.
    scripted.extractJson = fence([
      {
        entity: 'purchase_orders',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme PO' },
        label: 'Acme PO',
        confidence: 0.95,
      },
    ]);
    const out = await run();

    const rows = (await db.query('purchase_orders', {})) as Record<string, unknown>[];
    expect(rows.length).toBe(0);
    expect(out.dropped.length).toBe(1);
    expect(out.dropped[0]?.entity).toBe('purchase_orders');
    expect(out.dropped[0]?.label).toBe('Acme PO');
    expect(out.dropped[0]?.reason).toBeTruthy();
    expect(feedEvents.some((e) => (e.summary ?? '').includes('Acme PO'))).toBe(true);
  });

  it('reports nothing dropped on a clean run', async () => {
    scripted.extractJson = fence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Beta Supply' },
        label: 'Beta Supply',
        confidence: 0.95,
      },
    ]);
    const out = await run();
    expect(out.dropped).toEqual([]);
    const rows = (await db.query('suppliers', {})) as Record<string, unknown>[];
    expect(rows.filter((r) => !r.deleted_at).length).toBe(2);
  });
});
