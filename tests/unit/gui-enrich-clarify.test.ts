import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import type { MutationCtx } from '../../src/gui/mutations.js';
import { enrichWithLlm } from '../../src/gui/ai/enrich.js';
import { listPendingQuestions, parseQuestionContext } from '../../src/gui/questions.js';
import { parseObjects } from '../../src/ai/summarize.js';
import type { TurnParams, TurnResult } from '../../src/gui/ai/chat.js';

/**
 * The first background clarify producer: enrich's object-extraction step gates
 * each extracted object on the model's target-entity confidence. ≥ threshold
 * (default 0.6) → materialize exactly as before; in [threshold/2, threshold) →
 * create NOTHING and enqueue a question instead (max 2 per file); < floor →
 * drop silently. A missing confidence means 1.0 — today's behavior, untouched.
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
vi.mock('../../src/gui/assistant-routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gui/assistant-routes.js')>();
  return { ...actual, resolveClaudeAuth: () => Promise.resolve({ apiKey: 'test-key' }) };
});

function extractFence(objects: unknown[]): string {
  return '```json\n' + JSON.stringify(objects) + '\n```';
}

describe('enrich extraction clarify gate', () => {
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
    // Preferences (incl. clarify_threshold) read from an isolated dir → default 0.6.
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

  it('marginal confidence: no row/entity is created — a question is enqueued instead', async () => {
    scripted.extractJson = extractFence([
      {
        entity: 'suppliers',
        isNew: false,
        columns: ['name'],
        values: { name: 'Acme Corp' },
        label: 'Acme Corp',
        confidence: 0.45, // in [0.3, 0.6) — marginal
      },
    ]);
    await run();
    expect(await supplierCount()).toBe(0);
    expect(createdEntities).toEqual([]);
    const pending = await listPendingQuestions(db);
    expect(pending.length).toBe(1);
    expect(pending[0]?.source).toBe('enrich');
    expect(pending[0]?.question).toBe('Is "orders.txt" meant to add records to suppliers?');
    expect(JSON.parse(pending[0]?.options_json ?? '[]')).toEqual([
      'Yes, add them',
      'No, keep it as just a file',
    ]);
    // v1: the answer records intent (action none); a free-form answer enriches
    // the (existing) target entity's definition. Nothing re-runs automatically.
    expect(parseQuestionContext(pending[0]?.context_json ?? null)).toEqual({
      action: { kind: 'none' },
      enrich: [{ target: 'table_definition', table: 'suppliers' }],
    });
    // Open GUIs learned live.
    expect(feedEvents.some((e) => e.op === 'question' && e.source === 'ingest')).toBe(true);
  });

  it('a marginal NEW-entity proposal asks too — without creating the entity or an enrich target', async () => {
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
    expect(createdEntities).toEqual([]); // createEntity never called
    const pending = await listPendingQuestions(db);
    expect(pending.length).toBe(1);
    // The entity does not exist yet, so there is nothing to hang a definition on.
    expect(parseQuestionContext(pending[0]?.context_json ?? null).enrich).toEqual([]);
  });

  it('high confidence: acts exactly as before (row created, no question)', async () => {
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

  it('missing confidence: treated as 1.0 — behavior unchanged from before the gate', async () => {
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

  it('below the floor (< threshold/2): dropped silently — no row, no question', async () => {
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

  it('caps at 2 questions per ingested file', async () => {
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
    const pending = await listPendingQuestions(db);
    expect(pending.length).toBe(2);
    expect(createdEntities).toEqual([]);
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
