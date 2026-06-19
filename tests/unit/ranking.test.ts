import { describe, it, expect } from 'vitest';
import { recencyBoost, rewardBoost, rankingBoost } from '../../src/search/ranking.js';

const NOW = Date.parse('2026-01-30T00:00:00Z');

describe('recencyBoost', () => {
  it('is 1.0 at age 0 and 0.5 at one half-life', () => {
    const fresh = recencyBoost(
      { created_at: '2026-01-30T00:00:00Z' },
      { column: 'created_at', halfLifeDays: 10, weight: 1 },
      NOW,
    );
    expect(fresh).toBeCloseTo(1, 6);
    const oneHalfLife = recencyBoost(
      { created_at: '2026-01-20T00:00:00Z' },
      { column: 'created_at', halfLifeDays: 10, weight: 1 },
      NOW,
    );
    expect(oneHalfLife).toBeCloseTo(0.5, 6);
    const twoHalfLives = recencyBoost(
      { created_at: '2026-01-10T00:00:00Z' },
      { column: 'created_at', halfLifeDays: 10, weight: 1 },
      NOW,
    );
    expect(twoHalfLives).toBeCloseTo(0.25, 6);
  });

  it('returns 0 for a missing / unparseable timestamp', () => {
    expect(recencyBoost({}, { column: 'created_at', halfLifeDays: 10, weight: 1 }, NOW)).toBe(0);
    expect(
      recencyBoost(
        { created_at: 'not-a-date' },
        { column: 'created_at', halfLifeDays: 10, weight: 1 },
        NOW,
      ),
    ).toBe(0);
  });

  it('accepts epoch-ms timestamps', () => {
    const b = recencyBoost({ ts: NOW }, { column: 'ts', halfLifeDays: 10, weight: 1 }, NOW);
    expect(b).toBeCloseTo(1, 6);
  });
});

describe('rewardBoost', () => {
  it('saturates: 0 → 0, 1 → 0.5, 3 → 0.75', () => {
    expect(rewardBoost({ _reward_total: 0 }, { weight: 1 })).toBe(0);
    expect(rewardBoost({ _reward_total: 1 }, { weight: 1 })).toBeCloseTo(0.5, 6);
    expect(rewardBoost({ _reward_total: 3 }, { weight: 1 })).toBeCloseTo(0.75, 6);
  });

  it('honors a custom column and ignores negatives', () => {
    expect(rewardBoost({ score: 1 }, { column: 'score', weight: 1 })).toBeCloseTo(0.5, 6);
    expect(rewardBoost({ _reward_total: -5 }, { weight: 1 })).toBe(0);
  });
});

describe('rankingBoost (weighted combination)', () => {
  it('sums weighted signals', () => {
    const row = { created_at: '2026-01-20T00:00:00Z', _reward_total: 1 };
    const boost = rankingBoost(row, {
      recency: { column: 'created_at', halfLifeDays: 10, weight: 2 }, // 2 * 0.5 = 1.0
      reward: { weight: 1 }, // 1 * 0.5 = 0.5
      now: NOW,
    });
    expect(boost).toBeCloseTo(1.5, 6);
  });

  it('clamps a custom signal to [0,1]', () => {
    const boost = rankingBoost({}, { custom: { fn: () => 5, weight: 1 }, now: NOW });
    expect(boost).toBeCloseTo(1, 6); // 5 clamped to 1
  });

  it('is 0 with no signals', () => {
    expect(rankingBoost({ a: 1 }, { now: NOW })).toBe(0);
  });
});
