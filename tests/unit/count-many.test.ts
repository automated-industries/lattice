import { describe, it, expect } from 'vitest';
import { countManyPostgres, exactCountMany } from '../../src/gui/count-many.js';
import type { StorageAdapter } from '../../src/db/adapter.js';
import type { Row } from '../../src/types.js';

/**
 * Minimal adapter spy. Counts allAsync invocations and the SQL it was
 * called with, then returns a canned result. We only need the methods
 * countManyPostgres actually touches.
 */
function makeSpyAdapter(canned: Row[]): {
  adapter: StorageAdapter;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const adapter = {
    dialect: 'postgres' as const,
    allAsync(sql: string, params: unknown[] = []): Promise<Row[]> {
      calls.push({ sql, params });
      return Promise.resolve(canned);
    },
  } as unknown as StorageAdapter;
  return { adapter, calls };
}

describe('countManyPostgres', () => {
  it('issues exactly one query regardless of table count', async () => {
    const tableNames = Array.from({ length: 95 }, (_, i) => `t_${i}`);
    const canned: Row[] = tableNames.map((name, i) => ({
      name,
      row_count: i * 10,
    }));
    const { adapter, calls } = makeSpyAdapter(canned);

    const result = await countManyPostgres(adapter, tableNames);

    expect(calls.length).toBe(1);
    expect(calls[0].sql).toMatch(/pg_class/);
    expect(calls[0].sql).toMatch(/reltuples/);
    expect(calls[0].params).toEqual([tableNames]);
    expect(result.size).toBe(95);
    expect(result.get('t_5')).toBe(50);
  });

  it('returns an empty map without querying when given no tables', async () => {
    const { adapter, calls } = makeSpyAdapter([]);
    const result = await countManyPostgres(adapter, []);
    expect(calls.length).toBe(0);
    expect(result.size).toBe(0);
  });

  it('omits tables whose reltuples is < 0 (never-analyzed)', async () => {
    const { adapter } = makeSpyAdapter([
      { name: 'analyzed', row_count: 42 },
      { name: 'fresh', row_count: -1 },
    ]);
    const result = await countManyPostgres(adapter, ['analyzed', 'fresh']);
    expect(result.get('analyzed')).toBe(42);
    expect(result.has('fresh')).toBe(false);
  });

  it('coerces bigint row counts into Number', async () => {
    const { adapter } = makeSpyAdapter([{ name: 't', row_count: 12345n as unknown as number }]);
    const result = await countManyPostgres(adapter, ['t']);
    expect(result.get('t')).toBe(12345);
  });

  it('returns empty map when adapter has no allAsync (defensive)', async () => {
    const adapter = { dialect: 'postgres' } as unknown as StorageAdapter;
    const result = await countManyPostgres(adapter, ['t']);
    expect(result.size).toBe(0);
  });
});

/** Spy returning a single canned aggregate row from getAsync. */
function makeGetSpy(canned: Row | undefined): {
  adapter: StorageAdapter;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const adapter = {
    dialect: 'postgres' as const,
    getAsync(sql: string, params: unknown[] = []): Promise<Row | undefined> {
      calls.push({ sql, params });
      return Promise.resolve(canned);
    },
  } as unknown as StorageAdapter;
  return { adapter, calls };
}

describe('exactCountMany', () => {
  it('issues ONE aggregated query and maps columns back to their tables', async () => {
    const { adapter, calls } = makeGetSpy({ c0: 18, c1: 5 });
    const result = await exactCountMany(adapter, ['projects', 'meetings'], new Set(['meetings']));

    expect(calls.length).toBe(1); // pool-safe: one round-trip, not a per-table fan-out
    expect(calls[0]?.sql).toMatch(/\(SELECT count\(\*\) FROM "projects"\) AS c0/);
    // soft-delete table gets the deleted_at filter (matches the SQLite exact path)
    expect(calls[0]?.sql).toMatch(
      /\(SELECT count\(\*\) FROM "meetings" WHERE "deleted_at" IS NULL\) AS c1/,
    );
    expect(result.get('projects')).toBe(18);
    expect(result.get('meetings')).toBe(5);
  });

  it('returns an empty map without querying for no tables', async () => {
    const { adapter, calls } = makeGetSpy(undefined);
    const result = await exactCountMany(adapter, [], new Set());
    expect(calls.length).toBe(0);
    expect(result.size).toBe(0);
  });

  it('caps the subset (no silent over-scan of a never-analyzed fresh DB)', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `t_${i}`);
    const canned: Row = {};
    for (let i = 0; i < 50; i++) canned[`c${i}`] = i;
    const { adapter, calls } = makeGetSpy(canned);

    const result = await exactCountMany(adapter, names, new Set());
    expect(calls[0]?.sql).toMatch(/AS c49\b/);
    expect(calls[0]?.sql).not.toMatch(/AS c50\b/);
    expect(result.size).toBe(50);
    expect(result.has('t_55')).toBe(false);
  });

  it('coerces bigint counts to Number', async () => {
    const { adapter } = makeGetSpy({ c0: 99n as unknown as number });
    const result = await exactCountMany(adapter, ['t'], new Set());
    expect(result.get('t')).toBe(99);
  });

  it('returns an empty map when adapter has no getAsync (defensive)', async () => {
    const adapter = { dialect: 'postgres' } as unknown as StorageAdapter;
    const result = await exactCountMany(adapter, ['t'], new Set());
    expect(result.size).toBe(0);
  });
});
