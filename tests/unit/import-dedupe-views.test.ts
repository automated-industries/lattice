import { describe, expect, it } from 'vitest';
import { inferSchema } from '../../src/import/infer.js';
import { dedupeAndDetectViews } from '../../src/import/dedupe-views.js';

/** Master investments table (has a `fund` column) + two per-fund tabs that are
 *  the master filtered by fund with the fund column dropped + an unrelated table. */
function data() {
  return {
    'All Investments': [
      { company: 'A', fund: 'F1', invested: 10, region: 'NA' },
      { company: 'B', fund: 'F1', invested: 20, region: 'EU' },
      { company: 'C', fund: 'F2', invested: 30, region: 'NA' },
    ],
    F1: [
      { company: 'A', invested: 10, region: 'NA' },
      { company: 'B', invested: 20, region: 'EU' },
    ],
    F2: [{ company: 'C', invested: 30, region: 'NA' }],
    Sectors: [
      { sector: 'Tech', weight: 0.6 },
      { sector: 'Health', weight: 0.4 },
    ],
  };
}

describe('dedupeAndDetectViews', () => {
  it('recognizes per-fund tabs as views of the master and drops them as tables', () => {
    const d = data();
    const plan = inferSchema(d);
    const { plan: next, views } = dedupeAndDetectViews(plan, d);

    // F1 + F2 detected as views of the master; Sectors + master untouched.
    expect(views.map((v) => v.name).sort()).toEqual(['f1', 'f2']);
    for (const v of views) {
      expect(v.master).toBe('all_investments');
      expect(v.filterColumn).toBe('fund');
    }
    expect(views.find((v) => v.name === 'f1')?.filterValue).toBe('F1');
    expect(views.find((v) => v.name === 'f1')?.matchedRows).toBe(2);
    expect(views.find((v) => v.name === 'f2')?.matchedRows).toBe(1);

    // The view entities are removed from the table set; master + unrelated remain.
    const names = next.entities.map((e) => e.name).sort();
    expect(names).toContain('all_investments');
    expect(names).toContain('sectors');
    expect(names).not.toContain('f1');
    expect(names).not.toContain('f2');
  });

  it('leaves tables alone when there is no containing master', () => {
    const d = {
      Alpha: [
        { id: '1', x: 1 },
        { id: '2', x: 2 },
      ],
      Beta: [{ name: 'p', y: 9 }],
    };
    const { views, plan: next } = dedupeAndDetectViews(inferSchema(d), d);
    expect(views).toHaveLength(0);
    expect(next.entities.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
  });
});
