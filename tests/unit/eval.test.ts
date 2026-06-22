import { describe, it, expect } from 'vitest';
import {
  evaluateRetrieval,
  detectRetrievalRegressions,
  type EvalQuery,
  type RetrievalEvalSummary,
} from '../../src/search/eval.js';

/**
 * Retrieval evaluation metrics. Values below are hand-computed so a regression
 * in the metric math (not just "a number changed") is caught.
 */
describe('evaluateRetrieval — metric correctness', () => {
  it('computes P@k, Recall@k, RR, nDCG, AP for a single query', async () => {
    // relevant = {a,b,c}; retriever returns [a,x,b,y,c].
    const queries: EvalQuery[] = [{ id: 'q1', query: 'q', relevant: ['a', 'b', 'c'] }];
    const ranked = ['a', 'x', 'b', 'y', 'c'];
    const s = await evaluateRetrieval(queries, () => ranked, { k: 3 });

    const pq = s.perQuery[0]!;
    // P@3: a,x,b → a,b relevant = 2/3
    expect(pq.precisionAtK).toBeCloseTo(2 / 3, 6);
    // Recall@3: 2 of 3 relevant in top3
    expect(pq.recallAtK).toBeCloseTo(2 / 3, 6);
    // RR: a is relevant at rank 1
    expect(pq.reciprocalRank).toBeCloseTo(1, 6);
    // nDCG@3: DCG = 1 + 0 + 1/log2(4)=0.5 = 1.5; IDCG = 1 + 1/log2(3) + 0.5 = 2.13093
    expect(pq.ndcgAtK).toBeCloseTo(1.5 / 2.13092975, 5);
    // AP: relevant at ranks 1,3,5 → (1/1 + 2/3 + 3/5)/3 = 0.755556
    expect(pq.averagePrecision).toBeCloseTo((1 + 2 / 3 + 3 / 5) / 3, 6);
  });

  it('honors graded relevance in nDCG', async () => {
    const queries: EvalQuery[] = [
      {
        query: 'q',
        relevant: [
          { id: 'a', gain: 3 },
          { id: 'b', gain: 2 },
          { id: 'c', gain: 1 },
        ],
      },
    ];
    // worst-first ordering
    const s = await evaluateRetrieval(queries, () => ['c', 'b', 'a'], { k: 3 });
    // DCG = 1/1 + 2/log2(3) + 3/log2(4) = 1 + 1.261860 + 1.5 = 3.761860
    // IDCG = 3/1 + 2/log2(3) + 1/log2(4) = 3 + 1.261860 + 0.5 = 4.761860
    expect(s.perQuery[0]!.ndcgAtK).toBeCloseTo(3.76186 / 4.76186, 4);
  });

  it('reciprocal rank is 0 when nothing relevant is returned', async () => {
    const s = await evaluateRetrieval([{ query: 'q', relevant: ['a'] }], () => ['x', 'y'], {
      k: 5,
    });
    expect(s.perQuery[0]!.reciprocalRank).toBe(0);
    expect(s.mrr).toBe(0);
  });

  it('averages across queries (MRR/MAP/nDCG means)', async () => {
    const queries: EvalQuery[] = [
      { query: 'q1', relevant: ['a'] },
      { query: 'q2', relevant: ['b'] },
    ];
    const retriever = (q: string) => (q === 'q1' ? ['a', 'z'] : ['z', 'b']);
    const s = await evaluateRetrieval(queries, retriever, { k: 2 });
    // q1 RR=1, q2 RR=1/2 → MRR=0.75
    expect(s.mrr).toBeCloseTo(0.75, 6);
    expect(s.queryCount).toBe(2);
  });

  it('reports per-cutoff metrics via ks', async () => {
    const s = await evaluateRetrieval(
      [{ query: 'q', relevant: ['a', 'b'] }],
      () => ['a', 'x', 'b'],
      {
        k: 3,
        ks: [1, 3],
      },
    );
    expect(s.byK).toBeDefined();
    expect(s.byK![1]!.precisionAtK).toBeCloseTo(1, 6); // a in top1
    expect(s.byK![3]!.precisionAtK).toBeCloseTo(2 / 3, 6);
  });

  it('supports async retrievers', async () => {
    const s = await evaluateRetrieval(
      [{ query: 'q', relevant: ['a'] }],
      (q) => Promise.resolve([q === 'q' ? 'a' : 'z']),
      { k: 1 },
    );
    expect(s.precisionAtK).toBe(1);
  });

  it('throws loudly on an empty query set', async () => {
    await expect(evaluateRetrieval([], () => [])).rejects.toThrow(/empty/);
  });

  it('throws on a non-positive k', async () => {
    await expect(
      evaluateRetrieval([{ query: 'q', relevant: ['a'] }], () => ['a'], { k: 0 }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe('detectRetrievalRegressions', () => {
  const base: RetrievalEvalSummary = {
    k: 10,
    queryCount: 1,
    precisionAtK: 0.8,
    recallAtK: 0.7,
    mrr: 0.9,
    ndcgAtK: 0.85,
    map: 0.75,
    perQuery: [],
  };

  it('flags a metric that dropped beyond tolerance', () => {
    const cand = { ...base, ndcgAtK: 0.7 };
    const regs = detectRetrievalRegressions(base, cand, 0.02);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.metric).toBe('ndcgAtK');
    expect(regs[0]!.delta).toBeCloseTo(-0.15, 6);
  });

  it('ignores a drop within tolerance', () => {
    const cand = { ...base, map: 0.74 };
    expect(detectRetrievalRegressions(base, cand, 0.05)).toHaveLength(0);
  });

  it('does not flag improvements', () => {
    const cand = { ...base, precisionAtK: 0.95 };
    expect(detectRetrievalRegressions(base, cand)).toHaveLength(0);
  });
});
