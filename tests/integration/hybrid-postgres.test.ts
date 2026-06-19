/**
 * Postgres dialect-parity for p7 hybrid search: vector + FTS fusion (RRF), FTS
 * scoring via ts_rank, ranking signals, and the score breakdown — on a real
 * Postgres cluster.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import type { EmbeddingsConfig } from '../../src/types.js';

const PG_URL = process.env.LATTICE_TEST_PG_URL;

function tokenEmbed(dim = 12) {
  return (text: string): Promise<number[]> => {
    const v = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of tok) h = (h + ch.charCodeAt(0)) % dim;
      v[h] = (v[h] ?? 0) + 1;
    }
    return Promise.resolve(v);
  };
}

const embConfig: EmbeddingsConfig = {
  fields: ['title', 'body'],
  embed: tokenEmbed(12),
  modelId: 'm1',
};

describe.skipIf(!PG_URL)('hybridSearch (Postgres)', () => {
  let db: Lattice;
  const runId = randomBytes(4).toString('hex');
  const table = `__lattice_test_${runId}_docs`;

  beforeAll(async () => {
    db = new Lattice(PG_URL!);
    db.define(table, {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        body: 'TEXT',
        created_at: 'TEXT',
        deleted_at: 'TEXT',
      },
      fts: { fields: ['title', 'body'] },
      embeddings: embConfig,
      render: () => '',
      outputFile: '/dev/null',
    });
    await db.init();
    await db.insert(table, {
      id: 'd1',
      title: 'budget review',
      body: 'quarterly finance planning',
    });
    await db.insert(table, { id: 'd2', title: 'logistics note', body: 'shipping and warehouse' });
    await db.insert(table, { id: 'd3', title: 'budget', body: 'gardens and flowers' });
    await db.refreshEmbeddings(table);
  });

  afterAll(async () => {
    try {
      await runAsyncOrSync(db.adapter, `DROP TABLE IF EXISTS "${table}" CASCADE`);
      await runAsyncOrSync(
        db.adapter,
        `DELETE FROM "_lattice_embeddings" WHERE table_name='${table}'`,
      );
    } catch {
      /* best effort */
    }
    db.close();
  });

  it('fuses arms and returns a score breakdown on Postgres', async () => {
    const results = await db.hybridSearch(table, 'budget finance', { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.row.id).toBe('d1');
    expect(results[0]!.explain.rrf).toBeGreaterThan(0);
  });

  it('FTS arm is relevance-scored (ts_rank) on Postgres', async () => {
    const results = await db.hybridSearch(table, 'budget', { topK: 3 });
    // both d1 and d3 contain "budget"; FTS scores are populated (non-null rank)
    const withFts = results.filter((r) => r.explain.ftsRank !== null);
    expect(withFts.length).toBeGreaterThan(0);
    expect(typeof withFts[0]!.explain.ftsScore).toBe('number');
  });

  it('applies a recency boost on Postgres', async () => {
    await db.insert(table, {
      id: 'r-old',
      title: 'budget',
      body: 'finance',
      created_at: '2020-01-01T00:00:00Z',
    });
    await db.insert(table, {
      id: 'r-new',
      title: 'budget',
      body: 'finance',
      created_at: '2026-01-30T00:00:00Z',
    });
    await db.refreshEmbeddings(table);
    const now = Date.parse('2026-01-30T00:00:00Z');
    const results = await db.hybridSearch(table, 'budget finance', {
      topK: 5,
      ranking: { recency: { column: 'created_at', halfLifeDays: 30, weight: 5 }, now },
    });
    const ids = results.map((r) => r.row.id);
    expect(ids.indexOf('r-new')).toBeLessThan(ids.indexOf('r-old'));
  });
});
