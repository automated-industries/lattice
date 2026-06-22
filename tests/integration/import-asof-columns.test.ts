import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lattice,
  ensureLatticeRoot,
  addWorkspace,
  resolveWorkspacePaths,
  inferSchema,
  materializeImport,
  detectAsOfColumns,
  parseCellDate,
} from '../../src/index.js';

const dirs: string[] = [];
const dbs: Lattice[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.LATTICE_ROOT;
});

// Same logical fund at two report dates, plus a fund dimension to link to.
function dated() {
  return {
    positions: [
      { fund: 'Alpha', nav: 100, report_date: '2026-03-31' },
      { fund: 'Alpha', nav: 100, report_date: '2025-12-31' },
      { fund: 'Beta', nav: 200, report_date: '2026-03-31' },
      { fund: 'Beta', nav: 200, report_date: '2025-12-31' },
    ],
  };
}

describe('parseCellDate', () => {
  it('reads a Date (UTC), ISO, US, and long-month strings', () => {
    expect(parseCellDate(new Date(Date.UTC(2026, 2, 31)))).toBe('2026-03-31');
    expect(parseCellDate('2025-06-30')).toBe('2025-06-30');
    expect(parseCellDate('3/31/2026')).toBe('2026-03-31');
    expect(parseCellDate('March 31, 2026')).toBe('2026-03-31');
  });

  it('returns null for non-dates and bare numbers', () => {
    expect(parseCellDate('not a date')).toBeNull();
    expect(parseCellDate(42)).toBeNull();
    expect(parseCellDate(null)).toBeNull();
    expect(parseCellDate('')).toBeNull();
  });
});

describe('detectAsOfColumns', () => {
  it('finds a report-date column with its distinct-date count, ranked by name', () => {
    const data = dated();
    const cols = detectAsOfColumns(data, inferSchema(data));
    expect(cols[0]?.column).toBe('report_date');
    expect(cols[0]?.entity).toBe('positions');
    expect(cols[0]?.distinctDates).toBe(2);
    expect(cols[0]?.confidence).toBeGreaterThan(0.85);
  });

  it('does NOT offer a date column whose name is not an as-of (e.g. "founded")', () => {
    const data = {
      companies: [
        { name: 'A', founded: '2008-01-01' },
        { name: 'B', founded: '2010-05-02' },
        { name: 'C', founded: '2012-03-03' },
      ],
    };
    const cols = detectAsOfColumns(data, inferSchema(data));
    expect(cols.find((c) => c.column === 'founded')).toBeUndefined();
  });
});

describe('import: per-row as-of date column', () => {
  it('dates each row from its column, keeps a snapshot per date, links within each', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-asofcol-'));
    dirs.push(base);
    process.env.LATTICE_ROOT = join(base, '.lattice');
    const root = ensureLatticeRoot(base);
    const ws = addWorkspace(root, { displayName: 'AsOfCol' });
    const db = await Lattice.openWorkspace({ root, workspaceId: ws.id });
    dbs.push(db);
    const configPath = resolveWorkspacePaths(root, ws).configPath;
    const data = dated();

    const result = await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      asOfColumn: 'report_date',
    });
    expect(result.asOfColumn).toBe('report_date');
    expect(result.asOf).toBeNull();

    // Every row is its own period: 2 funds × 2 dates, dated by their own column.
    expect(await db.count('positions')).toBe(4);
    const asOfs = new Set((await db.query('positions')).map((r) => String(r.as_of)));
    expect([...asOfs].sort()).toEqual(['2025-12-31', '2026-03-31']);
    // The shared taxonomy (fund) is NOT dated — one row per value.
    expect(await db.count('fund')).toBe(2);

    // Each position links to its fund within its own snapshot.
    expect(await db.count('positions_fund')).toBe(4);
    const fundIds = new Set((await db.query('fund')).map((f) => String(f.id)));
    const edges = await db.query('positions_fund');
    expect(edges.every((e) => fundIds.has(String(e.fund_id)))).toBe(true);
    // One snapshot's slice resolves to exactly its rows.
    const pos26 = await db.query('positions', { where: { as_of: '2026-03-31' } });
    expect(pos26.length).toBe(2);

    // Re-applying the same file is idempotent — no extra snapshot, no dup links.
    await materializeImport({ db, configPath }, data, inferSchema(data), [], {
      asOfColumn: 'report_date',
    });
    expect(await db.count('positions')).toBe(4);
    expect(await db.count('positions_fund')).toBe(4);
  });
});
