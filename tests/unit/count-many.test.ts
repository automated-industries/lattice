import { describe, it, expect } from 'vitest';
import { countManyPostgres } from '../../src/gui/count-many.js';
import type { StorageAdapter, Row } from '../../src/db/adapter.js';

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
