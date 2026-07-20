import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import type { FillLlm } from '../../src/schema/computed-fill.js';

/**
 * #10 AI computed COLUMNS — async fill + the "never serve stale" staleness contract.
 * An `ai_classify` / `ai_transform` field is a real column that starts NULL, is filled
 * by fillComputedFields() (an injected FillLlm — no model calls in the core DB layer),
 * and is re-NULLed on the write path the moment one of its input columns changes.
 */
describe('AI computed columns (#10) — fill + staleness (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  /** A deterministic fake model: classify → first label containing an input word; transform → uppercased. */
  function fakeLlm(calls: { system: string; user: string }[]): FillLlm {
    return {
      async complete({ system, user }) {
        calls.push({ system, user });
        if (system.includes('label')) {
          // classify: "bug" in the text → Bug, else Feature
          return /\bbug\b/i.test(user) ? 'Bug' : 'Feature';
        }
        return user.toUpperCase();
      },
    };
  }

  it('fills classify + transform cells, validates labels, and refills after a dep change', async () => {
    db = new Lattice(':memory:');
    db.define('doc', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        body: 'TEXT',
        category: 'TEXT',
        shout: 'TEXT',
        deleted_at: 'TEXT',
      },
      computedFields: {
        category: {
          kind: 'ai_classify',
          input: 'title',
          prompt: 'Classify',
          labels: ['Bug', 'Feature'],
        },
        shout: { kind: 'ai_transform', inputs: ['title', 'body'], prompt: 'Uppercase it' },
      },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();

    await db.insert('doc', { id: 'd1', title: 'a nasty bug', body: 'crashes' });
    await db.insert('doc', { id: 'd2', title: 'shiny thing', body: 'sparkle' });

    // Before fill, the AI columns are NULL (real columns, just unpopulated).
    expect((await db.get('doc', 'd1'))!.category).toBeNull();

    const calls: { system: string; user: string }[] = [];
    const report = await db.fillComputedFields('doc', fakeLlm(calls));
    expect(report.filled).toBe(4); // 2 rows × 2 AI fields
    expect(report.failed).toBe(0);

    expect((await db.get('doc', 'd1'))!.category).toBe('Bug');
    expect((await db.get('doc', 'd2'))!.category).toBe('Feature');
    expect((await db.get('doc', 'd1'))!.shout).toContain('NASTY BUG');

    // Changing an INPUT column NULLs the derived cell synchronously (never serve stale).
    await db.update('doc', 'd1', { title: 'now a feature request' });
    const stale = (await db.get('doc', 'd1'))!;
    expect(stale.category).toBeNull(); // classify input (title) changed → cleared
    expect(stale.shout).toBeNull(); // transform input (title) changed → cleared
    // d2 (untouched) keeps its filled values.
    expect((await db.get('doc', 'd2'))!.category).toBe('Feature');

    // Refill repopulates ONLY the cleared cells (d1's two), from the NEW input value.
    const report2 = await db.fillComputedFields('doc', fakeLlm(calls));
    expect(report2.filled).toBe(2); // d1: category + shout — d2 was never NULL
    expect((await db.get('doc', 'd1'))!.category).toBe('Feature'); // reclassified from new title
  });

  it('rejects an out-of-vocabulary label (leaves the cell NULL, counts a failure)', async () => {
    db = new Lattice(':memory:');
    db.define('doc', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', category: 'TEXT' },
      computedFields: {
        category: {
          kind: 'ai_classify',
          input: 'title',
          prompt: 'Classify',
          labels: ['Bug', 'Feature'],
        },
      },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    await db.insert('doc', { id: 'd1', title: 'whatever' });

    const rogue: FillLlm = {
      async complete() {
        return 'NotALabel';
      },
    };
    const report = await db.fillComputedFields('doc', rogue);
    expect(report.filled).toBe(0);
    expect(report.failed).toBe(1);
    expect((await db.get('doc', 'd1'))!.category).toBeNull();
  });

  it('a fill is bounded and idempotent — a second fill with nothing NULL is a no-op', async () => {
    db = new Lattice(':memory:');
    db.define('doc', {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', shout: 'TEXT' },
      computedFields: { shout: { kind: 'ai_transform', inputs: ['title'], prompt: 'up' } },
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    await db.insert('doc', { id: 'd1', title: 'hi' });
    const calls: { system: string; user: string }[] = [];
    await db.fillComputedFields('doc', fakeLlm(calls));
    const afterFirst = calls.length;
    await db.fillComputedFields('doc', fakeLlm(calls)); // nothing NULL → no model calls
    expect(calls.length).toBe(afterFirst);
  });
});
