/**
 * Postgres dialect-parity coverage for the p5 retrieval-health + benchmark
 * surface. Mirrors the SQLite unit tests so the diagnostics and harness are
 * verified against a real Postgres cluster, not just :memory:.
 *
 * Run locally: the vitest global setup boots a disposable Postgres automatically
 * (or set LATTICE_TEST_PG_URL to point at your own).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { benchmarkRetrieval } from '../../src/search/benchmark.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

describe.skipIf(!PG_URL)('retrieval health + benchmark (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_notes`;
  const fakeEmbed = (t: string) => Promise.resolve([t.length % 7, (t.length * 3) % 5, 1]);

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: { id: 'TEXT PRIMARY KEY', title: 'TEXT', body: 'TEXT', deleted_at: 'TEXT' },
      fts: { fields: ['title', 'body'] },
      embeddings: { fields: ['title', 'body'], embed: fakeEmbed },
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('reports full coverage and detects extension availability on Postgres', async () => {
    await db.insert(table, { id: 'n1', title: 'budget', body: 'review' });
    await db.insert(table, { id: 'n2', title: 'grocery', body: 'list' });

    const report = await db.diagnoseRetrieval({
      tables: [{ table, expectFts: true, expectEmbeddings: true }],
    });
    expect(report.dialect).toBe('postgres');
    const notes = report.tables.find((t) => t.table === table)!;
    expect(notes.rowCount).toBe(2);
    expect(notes.ftsCoverage).toBe(1);
    expect(notes.embeddingCoverage).toBe(1);
    // pgvector availability is reported (true or false; the field is present)
    expect(typeof report.extensions.pgvectorInstalled).toBe('boolean');
  });

  it('flags missing embeddings on Postgres', async () => {
    const t2 = `__lattice_test_${runId}_bare`;
    await runAsyncOrSync(
      db.adapter,
      `CREATE TABLE "${t2}" (id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT)`,
    );
    await runAsyncOrSync(db.adapter, `INSERT INTO "${t2}" (id, title) VALUES ('a','x')`);
    const report = await db.diagnoseRetrieval({
      tables: [{ table: t2, expectEmbeddings: true }],
    });
    const bare = report.tables.find((t) => t.table === t2)!;
    expect(bare.issues.some((i) => i.kind === 'embedding_missing' && i.severity === 'error')).toBe(
      true,
    );
    expect(report.healthy).toBe(false);
    await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${t2}" CASCADE`);
  });

  it('benchmark harness runs against Postgres and returns ordered percentiles', async () => {
    const report = await benchmarkRetrieval(db.adapter, {
      scale: { rows: 50, queries: 6, dim: 16 },
      table: `__lattice_test_${runId}_bench`,
    });
    expect(report.dialect).toBe('postgres');
    expect(report.query.count).toBe(6);
    expect(report.vector.p95).toBeGreaterThanOrEqual(report.vector.p50);
    expect(report.ingest.rowsPerSec).toBeGreaterThan(0);
  });
});
