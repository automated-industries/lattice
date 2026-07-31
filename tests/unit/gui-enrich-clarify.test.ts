import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { enrichWithLlm } from '../../src/gui/ai/enrich.js';
import { listPendingQuestions } from '../../src/gui/questions.js';
import { parseObjects } from '../../src/ai/summarize.js';
import type { TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * What enrich does with an object it is only partly sure about.
 *
 * It used to create nothing and enqueue a card: "Is <file> meant to add records
 * to <entity>?". The card could not do the thing it asked about — the stored
 * action was a no-op, so answering "Yes, add them" added nothing. Ingesting a
 * folder therefore produced a queue of questions that changed nothing whichever
 * way they were answered, and the records the extractor had already found were
 * discarded either way.
 *
 * Adding a row is additive and one click of Undo away, so the marginal band now
 * does the additive thing at the aggressiveness the workspace is configured for.
 * The noise floor is unchanged: below it, an object is still dropped in silence.
 *
 * These drive the exported `enrichWithLlm` the ingest routes call, against a real
 * database, with the model scripted — the rows and the question queue are read
 * back from that database afterwards.
 */

// The fake LLM answers by PROMPT (summary / classify / extract), not call
// order, so a skipped classify pass (empty catalog) can't shift the script.
const scripted = vi.hoisted(() => ({ extractJson: '' }));

vi.mock('../../src/gui/ai/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/ai/chat.js')>();
  return {
    ...actual,
    createAnthropicClient: () => ({
      runTurn(params: TurnParams): Promise<TurnResult> {
        const sys = params.system;
        let text = '';
        if (sys.includes('one or two sentence')) text = 'A test document.';
        else if (sys.includes('which existing records')) text = '```json\n[]\n```';
        else if (sys.includes('extracting the key structured objects')) {
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

function extractFence(objects: unknown[]): string {
  return '```json\n' + JSON.stringify(objects) + '\n```';
}

describe('enrich extraction confidence floor', () => {
  let tmpDir: string;
  let cfgDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let feedEvents: FeedEvent[];
  let mctx: MutationCtx;
  let fileId: string;
  let createdEntities: string[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-clarify-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'lattice-enrich-clarify-cfg-'));
    // Preferences (incl. clarify_threshold) read from an isolated dir → default 0.6,
    // so the noise floor is 0.3 and 0.45 sits in what used to be the asking band.
    process.env.LATTICE_CONFIG_DIR = cfgDir;
    db = new Lattice(join(tmpDir, 'test.db'));
    const t = (cols: Record<string, string>, out: string) => ({
      columns: cols,
      render: () => '',
      outputFile: out,
    });
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
    db.define(
      'suppliers',
      t({ id: 'TEXT PRIMARY KEY', name: 'TEXT', deleted_at: 'TEXT' }, '.s/suppliers.md'),
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
    fileId = await db.insert('files', { original_name: 'orders.txt', extracted_text: 'x' });
    feed = new FeedBus();
    feedEvents = [];
    feed.subscribe((e) => feedEvents.push(e));
    mctx = { db, feed, softDeletable: new Set(['files', 'suppliers']), source: 'ingest' };
    createdEntities = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  // Aggressiveness 0.6: extraction runs (≥ 0.4), new entities allowed (≥ 0.5),
  // and the unrelated note-capture fallback (≥ 0.66) stays out of the way.
  function run(): Promise<unknown> {
    return enrichWithLlm(
      mctx,
      db,
      fileId,
      'Acme Corp supplies fasteners. PO-1123.',
      'orders.txt',
      [], // junctions
      {}, // descriptions
      undefined, // createJunction
      0.6,
      (entity: string) => {
        createdEntities.push(entity);
        return Promise.resolve(null); // never actually create in these tests
      },
    );
  }

  async function supplierCount(): Promise<number> {
    const rows = (await db.query('suppliers', {})) as { deleted_at?: string }[];
    return rows.filter((r) => !r.deleted_at).length;
  }

  it('marginal confidence: the record is created, and nothing is queued to ask about it', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme Corp' },
        label: 'Acme Corp',
        confidence: 0.45, // above the 0.3 floor, below the 0.6 clarify threshold
      },
    ]);
    await run();

    expect(await supplierCount(), 'the extracted record landed').toBe(1);
    const rows = (await db.query('suppliers', {})) as { name?: string }[];
    expect(rows[0]?.name).toBe('Acme Corp');

    // The card that used to stand here asked whether to do the thing it had just
    // decided not to do, and could not do it if answered.
    expect(await listPendingQuestions(db), 'no question is queued').toEqual([]);
    expect(feedEvents.some((e) => e.op === 'question')).toBe(false);
  });

  it('a marginal NEW-entity proposal is acted on too, at the configured aggressiveness', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'ghosts',
        isNew: true,
        columns: ['name'],
        values: { name: 'Casper' },
        label: 'Casper',
        confidence: 0.5,
      },
    ]);
    await run();

    // Aggressiveness 0.6 allows new entities (≥ 0.5), so the marginal proposal
    // reaches the entity creator instead of being parked in a question.
    expect(createdEntities).toEqual(['ghosts']);
    expect(await listPendingQuestions(db)).toEqual([]);
  });

  it('several marginal proposals in one file all land — there is no queue to cap', async () => {
    scripted.extractJson = extractFence(
      ['alpha_things', 'beta_things', 'gamma_things'].map((entity, i) => ({
        entity,
        isNew: true,
        columns: ['name'],
        values: { name: `Item ${String(i)}` },
        label: `Item ${String(i)}`,
        confidence: 0.5,
      })),
    );
    await run();

    // Previously the first two became questions and the third was silently
    // dropped by a per-file cap — an ingest could lose findings to a limit on
    // how much it was allowed to ask.
    expect(createdEntities).toEqual(['alpha_things', 'beta_things', 'gamma_things']);
    expect(await listPendingQuestions(db)).toEqual([]);
  });

  it('high confidence: unchanged', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme Corp' },
        label: 'Acme Corp',
        confidence: 0.9,
      },
    ]);
    await run();
    expect(await supplierCount()).toBe(1);
    expect(await listPendingQuestions(db)).toEqual([]);
  });

  it('missing confidence: treated as 1.0 — behavior unchanged', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme Corp' },
        label: 'Acme Corp',
        // no confidence field at all
      },
    ]);
    await run();
    expect(await supplierCount()).toBe(1);
    expect(await listPendingQuestions(db)).toEqual([]);
  });

  it('below the floor (< threshold/2): still dropped silently — no row, no question', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme Corp' },
        label: 'Acme Corp',
        confidence: 0.2,
      },
    ]);
    await run();
    expect(await supplierCount()).toBe(0);
    expect(await listPendingQuestions(db)).toEqual([]);
    expect(feedEvents.some((e) => e.op === 'question')).toBe(false);
  });

  it('parseObjects clamps a wild confidence and drops a non-numeric one', () => {
    const objects = parseObjects(
      extractFence([
        {
          entity: 'a_things',
          isNew: true,
          columns: ['x'],
          values: { x: '1' },
          label: 'A',
          confidence: 7,
        },
        {
          entity: 'b_things',
          isNew: true,
          columns: ['x'],
          values: { x: '2' },
          label: 'B',
          confidence: 'high',
        },
      ]),
    );
    expect(objects[0]?.confidence).toBe(1); // clamped into [0, 1]
    expect(objects[1]?.confidence).toBeUndefined(); // junk → absent (→ 1.0 downstream)
  });
});
