import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../../src/db/adapter.js';
import { compileComputedTable } from '../../src/schema/computed-table.js';
import type {
  ComputedSchemaTable,
  CompiledComputedTable,
} from '../../src/schema/computed-table.js';
import {
  ensureAiTables,
  runComputedFill,
  purgeAiField,
  readComputedState,
  AI_MAP_TABLE,
  AI_CELL_TABLE,
} from '../../src/schema/computed-fill.js';
import type { FillLlm } from '../../src/schema/computed-fill.js';

/** Scripted LLM double: records every call, delegates to a handler. */
class FakeLlm implements FillLlm {
  calls: { system: string; user: string; model: string }[] = [];
  constructor(
    private readonly handler: (opts: { system: string; user: string; model: string }) => string,
  ) {}
  async complete(opts: { system: string; user: string; model: string }): Promise<string> {
    this.calls.push(opts);
    return this.handler(opts);
  }
}

/** Extract the classifier batch's input values from the user prompt. */
function batchValues(user: string): string[] {
  const line = user.split('\n').find((l) => l.startsWith('Input values: '));
  return line ? (JSON.parse(line.slice('Input values: '.length)) as string[]) : [];
}

const SCHEMA = new Map<string, ComputedSchemaTable>([
  [
    'ticket',
    {
      columns: new Set(['id', 'title', 'status', 'category_src', 'deleted_at']),
      relations: {},
      primaryKey: ['id'],
      hasDeletedAt: true,
    },
  ],
]);

describe('computed-fill (SQLite)', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('ticket', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        status: 'TEXT',
        category_src: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  async function createView(compiled: CompiledComputedTable): Promise<void> {
    await ensureAiTables(db.adapter);
    await runAsyncOrSync(db.adapter, `DROP VIEW IF EXISTS "${compiled.viewName}"`);
    await runAsyncOrSync(
      db.adapter,
      `CREATE VIEW "${compiled.viewName}" AS\n${compiled.selectSql}`,
    );
  }

  function compileClassify(): CompiledComputedTable {
    return compileComputedTable(
      'tview',
      {
        base: 'ticket',
        fields: {
          category: {
            kind: 'ai_classify',
            input: 'category_src',
            prompt: 'Pick the category.',
            labels: ['hardware', 'software'],
          },
        },
      },
      SCHEMA,
      'sqlite',
    );
  }

  function compileTransform(): CompiledComputedTable {
    return compileComputedTable(
      'tview',
      {
        base: 'ticket',
        fields: {
          summary: {
            kind: 'ai_transform',
            inputs: ['title', 'status'],
            prompt: 'Summarize the ticket.',
          },
        },
      },
      SCHEMA,
      'sqlite',
    );
  }

  it('classifies only never-seen DISTINCT values, in one batch call', async () => {
    const compiled = compileClassify();
    await createView(compiled);
    // 5 rows, 3 distinct inputs (one of them duplicated three times).
    await db.insert('ticket', { id: 't1', category_src: 'mouse' });
    await db.insert('ticket', { id: 't2', category_src: 'mouse' });
    await db.insert('ticket', { id: 't3', category_src: 'mouse' });
    await db.insert('ticket', { id: 't4', category_src: 'linux' });
    await db.insert('ticket', { id: 't5', category_src: 'vim' });
    await db.insert('ticket', { id: 't6', category_src: null });

    const llm = new FakeLlm(({ user }) => {
      const mapping: Record<string, string | null> = {};
      for (const v of batchValues(user)) {
        mapping[v] = v === 'mouse' ? 'hardware' : v === 'linux' ? 'software' : null;
      }
      return JSON.stringify(mapping);
    });
    const report = await runComputedFill(db.adapter, llm, compiled);

    expect(llm.calls).toHaveLength(1);
    expect(batchValues(llm.calls[0]!.user).sort()).toEqual(['linux', 'mouse', 'vim']);
    expect(report.fields[0]).toMatchObject({ status: 'idle', filled: 3, pending: 0 });

    const rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "tview" ORDER BY "id"`);
    expect(rows.map((r) => r.category)).toEqual([
      'hardware',
      'hardware',
      'hardware',
      'software',
      null, // model declined 'vim' → NULL label, stored so it is never re-asked
      null, // NULL input never reaches the model
    ]);

    // Second fill: everything (including the declined value) is memoized.
    const llm2 = new FakeLlm(() => '{}');
    const report2 = await runComputedFill(db.adapter, llm2, compiled);
    expect(llm2.calls).toHaveLength(0);
    expect(report2.fields[0]).toMatchObject({ status: 'idle', filled: 0, pending: 0 });
  });

  it('respects the batch size for classifier calls', async () => {
    const compiled = compileClassify();
    await createView(compiled);
    for (let i = 0; i < 5; i++) {
      await db.insert('ticket', { id: `t${String(i)}`, category_src: `val${String(i)}` });
    }
    const llm = new FakeLlm(({ user }) =>
      JSON.stringify(Object.fromEntries(batchValues(user).map((v) => [v, 'hardware']))),
    );
    await runComputedFill(db.adapter, llm, compiled, { batchSize: 2 });
    expect(llm.calls).toHaveLength(3); // 2 + 2 + 1
  });

  it('never stores an out-of-set label; records the failure and stops the field', async () => {
    const compiled = compileClassify();
    await createView(compiled);
    await db.insert('ticket', { id: 't1', category_src: 'mouse' });
    await db.insert('ticket', { id: 't2', category_src: 'linux' });

    const llm = new FakeLlm(({ user }) => {
      const mapping: Record<string, string> = {};
      for (const v of batchValues(user)) mapping[v] = v === 'mouse' ? 'hardware' : 'not-a-label';
      return JSON.stringify(mapping);
    });
    const report = await runComputedFill(db.adapter, llm, compiled);

    expect(report.fields[0]?.status).toBe('error');
    expect(report.fields[0]?.error).toMatch(/out-of-set/);
    expect(report.fields[0]?.pending).toBe(1);

    const stored = await allAsyncOrSync(db.adapter, `SELECT * FROM "${AI_MAP_TABLE}"`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ input_value: 'mouse', label: 'hardware' });

    const state = await readComputedState(db.adapter, 'tview');
    expect(state[0]).toMatchObject({ field: 'category', status: 'error' });
    // The rejected value reads NULL through the view — never a wrong label.
    const row = await getAsyncOrSync(db.adapter, `SELECT * FROM "tview" WHERE "id" = 't2'`);
    expect(row?.category).toBeNull();
  });

  it('treats an unparseable classifier response as a field error', async () => {
    const compiled = compileClassify();
    await createView(compiled);
    await db.insert('ticket', { id: 't1', category_src: 'mouse' });
    const llm = new FakeLlm(() => 'certainly! here is your JSON:');
    const report = await runComputedFill(db.adapter, llm, compiled);
    expect(report.fields[0]?.status).toBe('error');
    expect(report.fields[0]?.error).toMatch(/unparseable/);
  });

  it('fills transforms per row and reads NULL the moment a source row changes', async () => {
    const compiled = compileTransform();
    await createView(compiled);
    await db.insert('ticket', { id: 't1', title: 'Broken mouse', status: 'open' });
    await db.insert('ticket', { id: 't2', title: 'Slow boot', status: 'closed' });

    let n = 0;
    const llm = new FakeLlm(() => `summary-${String(++n)}`);
    const report = await runComputedFill(db.adapter, llm, compiled);
    expect(llm.calls).toHaveLength(2); // one call per row
    expect(report.fields[0]).toMatchObject({ status: 'idle', filled: 2, pending: 0 });

    let rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "tview" ORDER BY "id"`);
    expect(rows.map((r) => r.summary)).toEqual(['summary-1', 'summary-2']);

    // Change one source row: its input_key no longer matches, so the view
    // reads NULL immediately — never the stale summary.
    await db.update('ticket', 't1', { title: 'Broken keyboard' });
    rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "tview" ORDER BY "id"`);
    expect(rows.map((r) => r.summary)).toEqual([null, 'summary-2']);

    // Refill: only the stale row is re-derived, and its cell row is REPLACED.
    const llm2 = new FakeLlm(() => 'summary-3');
    await runComputedFill(db.adapter, llm2, compiled);
    expect(llm2.calls).toHaveLength(1);
    expect(llm2.calls[0]?.user).toContain('Broken keyboard');
    rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "tview" ORDER BY "id"`);
    expect(rows.map((r) => r.summary)).toEqual(['summary-3', 'summary-2']);
    const cells = await allAsyncOrSync(db.adapter, `SELECT * FROM "${AI_CELL_TABLE}"`);
    expect(cells).toHaveLength(2); // upsert on (field, row) — no duplicates
  });

  it('stops a field on a model error, keeps written rows, reports the failure', async () => {
    const compiled = compileTransform();
    await createView(compiled);
    await db.insert('ticket', { id: 't1', title: 'a', status: 'open' });
    await db.insert('ticket', { id: 't2', title: 'b', status: 'open' });

    let calls = 0;
    const llm = new FakeLlm(() => {
      if (++calls > 1) throw new Error('rate limited');
      return 'first';
    });
    const report = await runComputedFill(db.adapter, llm, compiled);
    expect(report.fields[0]?.status).toBe('error');
    expect(report.fields[0]?.error).toMatch(/rate limited/);
    expect(report.fields[0]?.filled).toBe(1);
    expect(report.fields[0]?.pending).toBe(1);

    const state = await readComputedState(db.adapter, 'tview');
    expect(state[0]).toMatchObject({ field: 'summary', status: 'error', pending: 1, filled: 1 });

    // The unfilled row reads NULL (never stale); the filled one stays.
    const rows = await allAsyncOrSync(db.adapter, `SELECT * FROM "tview" ORDER BY "id"`);
    expect(rows.map((r) => r.summary)).toEqual(['first', null]);
  });

  it('purges a field on definitional change so the next fill re-derives', async () => {
    const compiled = compileTransform();
    await createView(compiled);
    await db.insert('ticket', { id: 't1', title: 'a', status: 'open' });
    await runComputedFill(db.adapter, new FakeLlm(() => 'old-output'), compiled);

    await purgeAiField(db.adapter, 'tview.summary');
    const cells = await allAsyncOrSync(db.adapter, `SELECT * FROM "${AI_CELL_TABLE}"`);
    expect(cells).toHaveLength(0);
    expect(await readComputedState(db.adapter, 'tview')).toHaveLength(0);
    const row = await getAsyncOrSync(db.adapter, `SELECT * FROM "tview" WHERE "id" = 't1'`);
    expect(row?.summary).toBeNull();

    const llm = new FakeLlm(() => 'new-output');
    await runComputedFill(db.adapter, llm, compiled);
    expect(llm.calls).toHaveLength(1);
    const after = await getAsyncOrSync(db.adapter, `SELECT * FROM "tview" WHERE "id" = 't1'`);
    expect(after?.summary).toBe('new-output');
  });

  it('passes the declared model tier through to the LLM adapter', async () => {
    const compiled = compileComputedTable(
      'tview',
      {
        base: 'ticket',
        fields: {
          category: {
            kind: 'ai_classify',
            input: 'category_src',
            prompt: 'p',
            labels: ['a'],
            model: 'cheapest',
          },
        },
      },
      SCHEMA,
      'sqlite',
    );
    await createView(compiled);
    await db.insert('ticket', { id: 't1', category_src: 'x' });
    const llm = new FakeLlm(({ user }) =>
      JSON.stringify(Object.fromEntries(batchValues(user).map((v) => [v, 'a']))),
    );
    await runComputedFill(db.adapter, llm, compiled);
    expect(llm.calls[0]?.model).toBe('cheapest');
  });

  it('excludes soft-deleted base rows from pending work', async () => {
    const compiled = compileClassify();
    await createView(compiled);
    await db.insert('ticket', {
      id: 't1',
      category_src: 'gone',
      deleted_at: new Date().toISOString(),
    });
    const llm = new FakeLlm(() => '{}');
    const report = await runComputedFill(db.adapter, llm, compiled);
    expect(llm.calls).toHaveLength(0);
    expect(report.fields[0]).toMatchObject({ status: 'idle', filled: 0, pending: 0 });
  });
});
