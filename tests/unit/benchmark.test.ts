import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import {
  benchmarkRetrieval,
  latencyStats,
  percentile,
  checkSlos,
} from '../../src/search/benchmark.js';

describe('benchmark stats helpers', () => {
  it('percentile picks the expected sample', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });

  it('latencyStats computes min/max/mean/percentiles', () => {
    const s = latencyStats([10, 20, 30, 40, 50]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
    expect(s.mean).toBe(30);
    expect(s.p50).toBe(30);
  });

  it('checkSlos flags only violations', () => {
    const report = {
      dialect: 'sqlite' as const,
      scale: { rows: 1, queries: 1, dim: 1 },
      ingest: { rows: 1, ms: 1, rowsPerSec: 1 },
      query: latencyStats([5]),
      fts: latencyStats([5]),
      vector: latencyStats([100]),
      aggregate: latencyStats([5]),
      peakRssBytes: 0,
    };
    const violations = checkSlos(report, [
      { metric: 'query.p95', maxMs: 50 },
      { metric: 'vector.p95', maxMs: 50 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.metric).toBe('vector.p95');
    expect(violations[0]!.observedMs).toBe(100);
  });
});

describe('benchmarkRetrieval (SQLite, small scale)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('runs end-to-end and returns sane stats; leaves no bench table behind', async () => {
    db = new Lattice(':memory:');
    await db.init();
    const report = await benchmarkRetrieval(db.adapter, {
      scale: { rows: 60, queries: 8, dim: 16 },
    });

    expect(report.dialect).toBe('sqlite');
    expect(report.scale.rows).toBe(60);
    expect(report.ingest.rows).toBe(60);
    expect(report.ingest.rowsPerSec).toBeGreaterThan(0);
    expect(report.query.count).toBe(8);
    expect(report.fts.count).toBe(8);
    expect(report.vector.count).toBe(8);
    expect(report.aggregate.count).toBe(8);
    // percentiles are non-negative and ordered
    expect(report.vector.p95).toBeGreaterThanOrEqual(report.vector.p50);
    expect(report.peakRssBytes).toBeGreaterThan(0);

    // The harness drops its synthetic table.
    const { introspectColumnsAsyncOrSync } = await import('../../src/db/adapter.js');
    const cols = await introspectColumnsAsyncOrSync(db.adapter, '_lattice_bench');
    expect(cols).toEqual([]);
  });
});
