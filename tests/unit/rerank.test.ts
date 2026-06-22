import { describe, it, expect } from 'vitest';
import { applyReranker, type RerankerFn } from '../../src/search/rerank.js';

const items = [
  { id: 'a', content: 'apple' },
  { id: 'b', content: 'banana' },
  { id: 'c', content: 'cherry' },
];

describe('applyReranker', () => {
  it('reorders by descending reranker score', async () => {
    const reranker: RerankerFn = (_q, cands) =>
      cands.map((c) => ({ id: c.id, score: c.id === 'c' ? 0.9 : c.id === 'a' ? 0.5 : 0.1 }));
    const { order, applied } = await applyReranker('q', items, reranker);
    expect(applied).toBe(true);
    expect(order.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps original order on a reranker that throws (graceful fallback)', async () => {
    const reranker: RerankerFn = () => {
      throw new Error('model down');
    };
    const { order, applied } = await applyReranker('q', items, reranker);
    expect(applied).toBe(false);
    expect(order.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps original order when the reranker returns an empty list', async () => {
    const { order, applied } = await applyReranker('q', items, () => []);
    expect(applied).toBe(false);
    expect(order.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('places unscored items after scored ones, preserving their order', async () => {
    const reranker: RerankerFn = () => [{ id: 'c', score: 1 }];
    const { order } = await applyReranker('q', items, reranker);
    // c scored → first; a,b unscored → original relative order after
    expect(order.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('supports async rerankers', async () => {
    const reranker: RerankerFn = (_q, cands) =>
      Promise.resolve(cands.map((c, i) => ({ id: c.id, score: i })));
    const { order } = await applyReranker('q', items, reranker);
    expect(order.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('returns empty input unchanged', async () => {
    const { order, applied } = await applyReranker('q', [], () => [{ id: 'a', score: 1 }]);
    expect(order).toEqual([]);
    expect(applied).toBe(false);
  });
});
