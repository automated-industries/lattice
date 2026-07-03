import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { FeedBus, type FeedEvent } from '../../src/gui/feed.js';
import { allAsyncOrSync } from '../../src/db/adapter.js';
import { LINEAGE_TABLE } from '../../src/gui/lineage-store.js';
import {
  QUESTIONS_TABLE,
  ensureQuestionsTable,
  enqueueQuestion,
  listPendingQuestions,
  getQuestion,
  answerQuestion,
  dismissQuestion,
  type QuestionsCtx,
} from '../../src/gui/questions.js';

/**
 * Clarification-question store: enqueue → (answer | dismiss), with the answer
 * executor running its deferred action + enrichment writes through the same
 * audited paths the assistant tools use. Failure semantics matter most here:
 * an executor error must leave the question PENDING (retryable), never
 * half-answered.
 */

describe('clarification-question store', () => {
  let tmpDir: string;
  let db: Lattice;
  let feed: FeedBus;
  let feedEvents: FeedEvent[];
  let ctx: QuestionsCtx;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-questions-'));
    db = new Lattice(join(tmpDir, 'test.db'));
    db.define('widgets', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', purpose: 'TEXT', deleted_at: 'TEXT' },
      render: () => '',
      outputFile: 'widgets.md',
    });
    db.define('_lattice_gui_meta', {
      columns: {
        entity_name: 'TEXT PRIMARY KEY',
        icon: 'TEXT',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      primaryKey: 'entity_name',
      render: () => '',
      outputFile: '.lattice-gui/meta.md',
    });
    db.define('_lattice_gui_column_meta', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        table_name: 'TEXT NOT NULL',
        column_name: 'TEXT NOT NULL',
        secret: 'INTEGER NOT NULL DEFAULT 0',
        description: 'TEXT',
        updated_at: "TEXT DEFAULT (datetime('now'))",
      },
      render: () => '',
      outputFile: '.lattice-gui/column-meta.md',
    });
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
      outputFile: '.lattice-gui/audit.md',
    });
    await db.init();
    await db.insert('widgets', { id: 'w1', name: 'Widget One' });
    feed = new FeedBus();
    feedEvents = [];
    feed.subscribe((e) => feedEvents.push(e));
    ctx = { db, feed, softDeletable: new Set(['widgets']) };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates its DDL idempotently (safe to ensure repeatedly)', async () => {
    await ensureQuestionsTable(db.adapter);
    await ensureQuestionsTable(db.adapter);
    // Still writable after the double-ensure (table + index both IF NOT EXISTS).
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is this meant to track suppliers?',
      options: ['Yes', 'No'],
    });
    expect((await getQuestion(db, id))?.status).toBe('pending');
  });

  it('enqueue inserts a pending row and publishes a question feed event', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is "orders.csv" meant to add records to orders?',
      options: ['Yes, add them', 'No, keep it as just a file'],
      feedSource: 'ingest',
    });
    const pending = await listPendingQuestions(db);
    expect(pending.map((q) => q.id)).toEqual([id]);
    expect(pending[0]?.source).toBe('enrich');
    expect(JSON.parse(pending[0]?.options_json ?? '[]')).toEqual([
      'Yes, add them',
      'No, keep it as just a file',
    ]);
    const ev = feedEvents.find((e) => e.op === 'question');
    expect(ev).toMatchObject({
      op: 'question',
      table: null, // bookkeeping table is feed-hidden by prefix — signal only
      rowId: id,
      source: 'ingest',
      summary: 'Is "orders.csv" meant to add records to orders?',
    });
  });

  it('answer executes a set_definition action through the shared definition path', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'What is the widgets list for?',
      options: ['Inventory', 'Suppliers'],
      context: { action: { kind: 'set_definition', table: 'widgets' } },
    });
    const outcome = await answerQuestion(ctx, id, 'Tracks the widgets we manufacture in-house');
    expect(outcome).toMatchObject({ id, status: 'answered', action: 'set_definition' });
    // The definition landed where the assistant's set_definition tool writes.
    const meta = (await db.get('_lattice_gui_meta', 'widgets')) as { description: string } | null;
    expect(meta?.description).toBe('Tracks the widgets we manufacture in-house');
    // Surfaced as an activity-card feed event + the resolution signal.
    expect(
      feedEvents.some(
        (e) => e.op === 'update' && e.table === 'widgets' && /definition/i.test(e.summary ?? ''),
      ),
    ).toBe(true);
    expect(feedEvents.filter((e) => e.op === 'question').length).toBe(2); // enqueue + answered
    // Stamped answered.
    const row = await getQuestion(db, id);
    expect(row?.status).toBe('answered');
    expect(row?.answer).toBe('Tracks the widgets we manufacture in-house');
    expect(row?.answered_at).toBeTruthy();
  });

  it('a free-form answer is persisted onto the enrich targets (audited row write + lineage)', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'assistant',
      question: 'What is Widget One for?',
      options: ['Retail', 'Internal'],
      context: {
        action: { kind: 'none' },
        enrich: [
          { target: 'row_field', table: 'widgets', column: 'purpose', rowId: 'w1' },
          { target: 'lineage_detail', table: 'widgets', rowId: 'w1' },
          { target: 'column_definition', table: 'widgets', column: 'purpose' },
        ],
      },
    });
    const outcome = await answerQuestion(ctx, id, 'Calibration rig for the assembly line');
    expect(outcome.enriched.length).toBe(3);
    // Row write went through updateRow — value + audit entry + feed event.
    const w1 = (await db.get('widgets', 'w1')) as { purpose: string } | null;
    expect(w1?.purpose).toBe('Calibration rig for the assembly line');
    const audits = (await db.query('_lattice_gui_audit', {})) as {
      table_name: string;
      operation: string;
      row_id: string | null;
    }[];
    expect(
      audits.some(
        (a) => a.table_name === 'widgets' && a.operation === 'update' && a.row_id === 'w1',
      ),
    ).toBe(true);
    expect(
      feedEvents.some((e) => e.op === 'update' && e.table === 'widgets' && e.rowId === 'w1'),
    ).toBe(true);
    // Lineage detail recorded against the question.
    const lineage = await allAsyncOrSync(
      db.adapter,
      `SELECT * FROM "${LINEAGE_TABLE}" WHERE "object_table" = 'widgets' AND "object_id" = 'w1'`,
    );
    expect(lineage.length).toBe(1);
    expect(lineage[0]).toMatchObject({
      source_kind: 'question',
      source_table: QUESTIONS_TABLE,
      source_id: id,
      relation: 'clarified_by',
    });
    expect(String(lineage[0]?.detail_json)).toContain('Calibration rig');
    // Column definition landed too.
    const colMeta = (await db.query('_lattice_gui_column_meta', {})) as {
      table_name: string;
      column_name: string;
      description: string;
    }[];
    expect(
      colMeta.some(
        (m) =>
          m.table_name === 'widgets' &&
          m.column_name === 'purpose' &&
          m.description === 'Calibration rig for the assembly line',
      ),
    ).toBe(true);
  });

  it('an option-only pick resolves the question but skips enrichment (nothing to persist)', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is "widgets.csv" meant to add records to widgets?',
      options: ['Yes, add them', 'No, keep it as just a file'],
      context: {
        action: { kind: 'none' },
        enrich: [{ target: 'table_definition', table: 'widgets' }],
      },
    });
    const outcome = await answerQuestion(ctx, id, 'No, keep it as just a file');
    expect(outcome.enriched).toEqual([]);
    expect(await db.get('_lattice_gui_meta', 'widgets')).toBeNull(); // no definition written
    expect((await getQuestion(db, id))?.status).toBe('answered'); // but the pick still resolves it
  });

  it('an executor failure leaves the question PENDING and surfaces the error', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'assistant',
      question: 'What is this row about?',
      options: ['A', 'B'],
      context: {
        action: { kind: 'none' },
        enrich: [
          { target: 'row_field', table: 'widgets', column: 'purpose', rowId: 'missing-row' },
        ],
      },
    });
    await expect(answerQuestion(ctx, id, 'Some free-form answer')).rejects.toThrow(/no row/i);
    const row = await getQuestion(db, id);
    expect(row?.status).toBe('pending'); // retryable — never half-answered
    expect(row?.answer).toBeNull();
    // Still listed for the GUI.
    expect((await listPendingQuestions(db)).map((q) => q.id)).toContain(id);
  });

  it('dismiss stamps the row and publishes the resolution signal; re-answering is refused', async () => {
    const id = await enqueueQuestion(db, feed, {
      source: 'import',
      question: 'Keep both sheets?',
      options: ['Yes', 'No'],
    });
    await dismissQuestion(ctx, id);
    const row = await getQuestion(db, id);
    expect(row?.status).toBe('dismissed');
    expect(row?.answered_at).toBeTruthy();
    expect(await listPendingQuestions(db)).toEqual([]);
    expect(feedEvents.filter((e) => e.op === 'question').length).toBe(2); // enqueue + dismissed
    // A resolved question can be neither re-answered nor re-dismissed.
    await expect(answerQuestion(ctx, id, 'Yes')).rejects.toThrow(/already dismissed/i);
    await expect(dismissQuestion(ctx, id)).rejects.toThrow(/already dismissed/i);
  });
});
