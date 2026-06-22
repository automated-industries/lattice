import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { runAsyncOrSync } from '../../src/db/adapter.js';
import type { EmbeddingsConfig } from '../../src/types.js';
import type { RerankerFn } from '../../src/search/rerank.js';

/**
 * p7 — hybrid (vector + FTS) search via Reciprocal Rank Fusion, plus ranking
 * signals, reranker, and the score breakdown.
 */

// Deterministic token embedder.
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

describe('hybridSearch (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(withEmbeddings = true): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        body: 'TEXT',
        created_at: 'TEXT',
        _reward_total: 'REAL',
        deleted_at: 'TEXT',
      },
      fts: { fields: ['title', 'body'] },
      ...(withEmbeddings ? { embeddings: embConfig } : {}),
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    return db;
  }

  async function insert(d: Lattice, row: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(row);
    const ph = cols.map(() => '?').join(',');
    await runAsyncOrSync(
      d.adapter,
      `INSERT INTO docs (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph})`,
      Object.values(row),
    );
  }

  it('fuses vector + FTS arms and reports a score breakdown', async () => {
    const d = await setup(true);
    await insert(d, { id: 'd1', title: 'budget review', body: 'quarterly finance planning' });
    await insert(d, { id: 'd2', title: 'logistics note', body: 'shipping and warehouse' });
    await insert(d, { id: 'd3', title: 'budget', body: 'unrelated text about gardens' });
    await d.refreshEmbeddings('docs');

    const results = await d.hybridSearch('docs', 'budget finance', { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    // d1 matches both lexically (budget) and semantically (finance) → should rank top.
    expect(results[0]!.row.id).toBe('d1');
    // explain carries both arms' ranks
    const top = results[0]!.explain;
    expect(top.rrf).toBeGreaterThan(0);
    expect(top.ftsRank === null && top.vectorRank === null).toBe(false);
  });

  it('works full-text-only when the table has no embeddings', async () => {
    const d = await setup(false);
    await insert(d, { id: 'd1', title: 'budget review', body: 'finance' });
    await insert(d, { id: 'd2', title: 'logistics', body: 'shipping' });
    const results = await d.hybridSearch('docs', 'budget', { topK: 2 });
    expect(results.map((r) => r.row.id)).toContain('d1');
    // vector arm absent
    expect(results[0]!.explain.vectorRank).toBeNull();
    expect(results[0]!.explain.ftsRank).not.toBeNull();
  });

  it('excludes soft-deleted rows from hybrid results', async () => {
    const d = await setup(true);
    await insert(d, { id: 'd1', title: 'budget', body: 'finance', deleted_at: '2020-01-01' });
    await insert(d, { id: 'd2', title: 'budget', body: 'finance' });
    await d.refreshEmbeddings('docs'); // d1 is soft-deleted → refresh skips it
    const results = await d.hybridSearch('docs', 'budget finance', { topK: 10 });
    expect(results.map((r) => r.row.id)).not.toContain('d1');
  });

  it('applies a recency ranking boost', async () => {
    const d = await setup(true);
    await insert(d, {
      id: 'old',
      title: 'budget',
      body: 'finance',
      created_at: '2020-01-01T00:00:00Z',
    });
    await insert(d, {
      id: 'new',
      title: 'budget',
      body: 'finance',
      created_at: '2026-01-30T00:00:00Z',
    });
    await d.refreshEmbeddings('docs');

    const now = Date.parse('2026-01-30T00:00:00Z');
    const results = await d.hybridSearch('docs', 'budget finance', {
      topK: 2,
      ranking: { recency: { column: 'created_at', halfLifeDays: 30, weight: 5 }, now },
    });
    // identical relevance, but 'new' gets the recency boost → ranks first
    expect(results[0]!.row.id).toBe('new');
    expect(results[0]!.explain.rankingBoost).toBeGreaterThan(0);
  });

  it('applies a reranker and records its score (graceful fallback on error)', async () => {
    const d = await setup(true);
    await insert(d, { id: 'd1', title: 'budget', body: 'finance' });
    await insert(d, { id: 'd2', title: 'logistics', body: 'shipping' });
    await insert(d, { id: 'd3', title: 'budget plan', body: 'finance numbers' });
    await d.refreshEmbeddings('docs');

    // Reranker that forces d2 to the top.
    const reranker: RerankerFn = (_q, cands) =>
      cands.map((c) => ({ id: c.id, score: c.id === 'd2' ? 1 : 0 }));
    const results = await d.hybridSearch('docs', 'budget', { topK: 3, reranker });
    expect(results[0]!.row.id).toBe('d2');
    expect(results[0]!.explain.rerankerScore).toBe(1);

    // A throwing reranker leaves fused order intact.
    const boom: RerankerFn = () => {
      throw new Error('down');
    };
    const fallback = await d.hybridSearch('docs', 'budget', { topK: 3, reranker: boom });
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback[0]!.explain.rerankerScore).toBeUndefined();
  });
});

describe('search() with a reranker (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('reranks semantic results and keeps order on reranker failure', async () => {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT', deleted_at: 'TEXT' },
      embeddings: embConfig,
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d1','alpha beta')`);
    await runAsyncOrSync(db.adapter, `INSERT INTO docs (id, body) VALUES ('d2','gamma delta')`);
    await db.refreshEmbeddings('docs');

    const reranker: RerankerFn = (_q, cands) =>
      cands.map((c) => ({ id: c.id, score: c.id === 'd2' ? 1 : 0 }));
    const reranked = await db.search('docs', 'alpha', { topK: 2, reranker });
    expect(reranked[0]!.row.id).toBe('d2');

    const boom: RerankerFn = () => {
      throw new Error('down');
    };
    const fallback = await db.search('docs', 'alpha', { topK: 2, reranker: boom });
    expect(fallback.length).toBe(2); // graceful fallback to similarity order
  });
});
