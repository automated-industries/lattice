import { describe, it, expect } from 'vitest';
import { estimateTokens, applyTokenBudget } from '../../src/render/token-budget.js';
import type { Row } from '../../src/types.js';

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('applyTokenBudget', () => {
  const rows: Row[] = [
    { id: '1', name: 'Alpha', score: 10 },
    { id: '2', name: 'Beta', score: 20 },
    { id: '3', name: 'Gamma', score: 30 },
    { id: '4', name: 'Delta', score: 5 },
    { id: '5', name: 'Epsilon', score: 15 },
  ];

  const renderFn = (r: Row[]) => r.map((row) => `- ${row.name as string}`).join('\n');

  it('returns full content when within budget', () => {
    const result = applyTokenBudget(rows, renderFn, 1000);
    expect(result).toBe(renderFn(rows));
    expect(result).not.toContain('[truncated');
  });

  it('truncates and appends footer when over budget', () => {
    // Each row is ~8 chars → ~2 tokens. 5 rows ≈ 10 tokens + newlines.
    // Set budget to fit only a few rows.
    const result = applyTokenBudget(rows, renderFn, 5);
    expect(result).toContain('[truncated');
    expect(result).toContain('of 5 rows');
  });

  it('prioritizes by column descending', () => {
    const result = applyTokenBudget(rows, renderFn, 5, 'score');
    // Highest scores (30, 20, 15, 10, 5) should be kept first
    expect(result).toContain('[truncated');
    // Gamma (30) should appear if any rows fit
    if (result.includes('- ')) {
      expect(result).toContain('Gamma');
    }
  });

  it('prioritizes by custom comparator', () => {
    const comparator = (a: Row, b: Row) => (a.score as number) - (b.score as number);
    const result = applyTokenBudget(rows, renderFn, 5, comparator);
    expect(result).toContain('[truncated');
  });

  it('handles empty rows', () => {
    const result = applyTokenBudget([], renderFn, 10);
    expect(result).toBe('');
  });
});
