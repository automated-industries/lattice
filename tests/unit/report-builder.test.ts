import { describe, it, expect } from 'vitest';
import { Lattice } from '../../src/lattice.js';

/**
 * buildReport interpolates the section's table, filter columns, and orderBy column
 * directly into SQL. They are validated with assertSafeIdentifier so a section whose
 * identifier isn't a plain identifier is rejected LOUDLY rather than reaching the
 * query string. (Report sections are dev-authored, but this is defense-in-depth: a
 * consumer that wires any untrusted value into a section name can't inject SQL.)
 */
async function makeDb(): Promise<Lattice> {
  const d = new Lattice(':memory:');
  d.define('events', {
    columns: { id: 'TEXT PRIMARY KEY', kind: 'TEXT', timestamp: 'TEXT', deleted_at: 'TEXT' },
    render: () => '',
    outputFile: '/dev/null',
  });
  await d.init();
  await d.insert('events', { id: '1', kind: 'a', timestamp: '2026-06-18T00:00:00Z' });
  await d.insert('events', { id: '2', kind: 'b', timestamp: '2026-06-18T01:00:00Z' });
  return d;
}

describe('report builder identifier hardening', () => {
  it('builds a section with valid identifiers', async () => {
    const d = await makeDb();
    const r = await d.buildReport({
      since: '2020-01-01T00:00:00Z',
      sections: [
        {
          name: 'all',
          query: { table: 'events', orderBy: 'timestamp', orderDir: 'asc' },
          format: 'list',
        },
      ],
    });
    expect(r.sections[0]?.count).toBe(2);
    d.close();
  });

  it('rejects an injection in a filter column', async () => {
    const d = await makeDb();
    await expect(
      d.buildReport({
        since: '2020-01-01T00:00:00Z',
        sections: [
          {
            name: 'x',
            query: {
              table: 'events',
              filters: [{ col: 'kind"; DROP TABLE events; --', op: 'eq', val: 'a' }],
            },
            format: 'list',
          },
        ],
      }),
    ).rejects.toThrow(/Invalid column name/);
    d.close();
  });

  it('rejects an injection in the orderBy column', async () => {
    const d = await makeDb();
    await expect(
      d.buildReport({
        since: '2020-01-01T00:00:00Z',
        sections: [
          {
            name: 'x',
            query: { table: 'events', orderBy: 'timestamp; DROP TABLE events' },
            format: 'list',
          },
        ],
      }),
    ).rejects.toThrow(/Invalid column name/);
    d.close();
  });

  it('rejects an injection in the table name', async () => {
    const d = await makeDb();
    await expect(
      d.buildReport({
        since: '2020-01-01T00:00:00Z',
        sections: [
          { name: 'x', query: { table: 'events"; DROP TABLE events; --' }, format: 'list' },
        ],
      }),
    ).rejects.toThrow(/Invalid table name/);
    d.close();
  });
});
