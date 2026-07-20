import { describe, it, expect, afterEach, vi } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { linkMaterializedRows } from '../../src/import/materialize.js';
import type { MaterializedLinkSpec } from '../../src/import/materialize.js';

/**
 * `linkMaterializedRows` (the clarification-question junction-creation path,
 * reachable from the /api/questions answer handler) builds its key maps from the
 * live rows of three tables. Those reads must be COLUMN-BOUNDED — projecting only
 * the id + match key (+ as_of when dated) — never a whole-row `SELECT *` of every
 * table pulled into JS. These tests assert both that the produced junction is
 * correct AND that every read is projected (the narrowing must not drop a needed
 * key).
 */
describe('linkMaterializedRows — bounded reads + correct links', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(withAsOf: boolean): Promise<Lattice> {
    const d = new Lattice(':memory:');
    db = d;
    const orgCols: Record<string, string> = { id: 'TEXT PRIMARY KEY', name: 'TEXT' };
    const projCols: Record<string, string> = { id: 'TEXT PRIMARY KEY', org_name: 'TEXT' };
    if (withAsOf) {
      orgCols.as_of = 'TEXT';
      projCols.as_of = 'TEXT';
    }
    d.define('orgs', { columns: orgCols, primaryKey: 'id', render: () => '', outputFile: 'o.md' });
    d.define('projects', {
      columns: projCols,
      primaryKey: 'id',
      render: () => '',
      outputFile: 'p.md',
    });
    await d.init();
    return d;
  }

  const spec: MaterializedLinkSpec = {
    junction: 'projects_orgs',
    fromTable: 'projects',
    fromColumn: 'org_name',
    toTable: 'orgs',
    toKey: 'name',
  };

  it('creates the correct junction rows and projects every read (undated)', async () => {
    const d = await setup(false);
    await d.insert('orgs', { id: 'o1', name: 'Acme' });
    await d.insert('orgs', { id: 'o2', name: 'Beta' });
    await d.insert('projects', { id: 'p1', org_name: 'Acme' });
    await d.insert('projects', { id: 'p2', org_name: 'Beta' });
    await d.insert('projects', { id: 'p3', org_name: 'Nonexistent' });

    const querySpy = vi.spyOn(d, 'query');
    const res = await linkMaterializedRows({ db: d, configPath: null }, spec);
    // Snapshot the reads this path issued BEFORE the correctness read below (and
    // before mockRestore, which clears mock.calls).
    const calls = querySpy.mock.calls.map((c) => [c[0], c[1]?.projection] as const);
    querySpy.mockRestore();

    // Correctness: two resolved links, one unresolved ref.
    expect(res).toEqual({ junction: 'projects_orgs', created: 2, unresolved: 1 });
    const links = await d.query('projects_orgs');
    const pairs = links.map((l) => `${String(l.projects_id)}->${String(l.orgs_id)}`).sort();
    expect(pairs).toEqual(['p1->o1', 'p2->o2']);

    // Every read this path issued is projected (never an unbounded `SELECT *`),
    // and the projection carries exactly the key columns the maps need.
    expect(calls.every(([, p]) => Array.isArray(p) && p.length > 0)).toBe(true);
    expect(calls.find(([t]) => t === 'orgs')?.[1]).toEqual(['id', 'name']);
    expect(calls.find(([t]) => t === 'projects_orgs')?.[1]).toEqual(['projects_id', 'orgs_id']);
    expect(calls.find(([t]) => t === 'projects')?.[1]).toEqual(['id', 'org_name']);
  });

  it('resolves within each snapshot and projects as_of when dated', async () => {
    const d = await setup(true);
    // Same org NAME in two snapshots, different rows/ids per snapshot.
    await d.insert('orgs', { id: 'o1a', name: 'Acme', as_of: '2026-01-01' });
    await d.insert('orgs', { id: 'o1b', name: 'Acme', as_of: '2026-02-01' });
    await d.insert('projects', { id: 'pA', org_name: 'Acme', as_of: '2026-01-01' });
    await d.insert('projects', { id: 'pB', org_name: 'Acme', as_of: '2026-02-01' });

    const querySpy = vi.spyOn(d, 'query');
    const res = await linkMaterializedRows({ db: d, configPath: null }, spec);
    const calls = querySpy.mock.calls.map((c) => [c[0], c[1]?.projection] as const);
    querySpy.mockRestore();

    expect(res.created).toBe(2);
    const links = await d.query('projects_orgs');
    const pairs = links.map((l) => `${String(l.projects_id)}->${String(l.orgs_id)}`).sort();
    // Each project links to the org row IN ITS OWN snapshot — the projection kept
    // as_of, so per-snapshot resolution still works after narrowing the columns.
    expect(pairs).toEqual(['pA->o1a', 'pB->o1b']);

    // as_of is included in the dated-side projections.
    expect(calls.find(([t]) => t === 'orgs')?.[1]).toContain('as_of');
    expect(calls.find(([t]) => t === 'projects')?.[1]).toContain('as_of');
  });
});
