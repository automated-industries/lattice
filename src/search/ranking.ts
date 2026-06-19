/**
 * Ranking signals — lightweight, deterministic boosts applied to a retrieval
 * score from columns already on the row, no model required. Pure relevance
 * (vector/FTS/hybrid) ignores how fresh, how rewarded, or how referenced a row
 * is; these signals fold that business context back into the ranking.
 *
 * Each signal yields a value in [0, 1]; the combined boost is a weighted sum,
 * and the caller multiplies the base score by `(1 + boost)` so a strong signal
 * lifts an already-relevant row without drowning relevance entirely.
 */

import type { Row } from '../types.js';

/** Exponential recency decay: 1.0 at age 0, 0.5 at one half-life, → 0 with age. */
export interface RecencySignal {
  /** Timestamp column (ISO-8601 string or epoch ms). */
  column: string;
  /** Half-life in days — the age at which the boost halves. */
  halfLifeDays: number;
  /** Weight of this signal in the combined boost. */
  weight: number;
}

/** Reward signal: saturating boost from a `_reward_total`-style column. */
export interface RewardSignal {
  /** Column holding the cumulative reward. Default `_reward_total`. */
  column?: string;
  /** Weight of this signal in the combined boost. */
  weight: number;
}

/** A custom per-row signal returning a value in [0, 1]. */
export interface CustomSignal {
  fn: (row: Row) => number;
  weight: number;
}

export interface RankingOptions {
  recency?: RecencySignal;
  reward?: RewardSignal;
  custom?: CustomSignal;
  /**
   * Reference time (epoch ms) for recency decay. Defaults to `Date.now()`.
   * Pass it for deterministic ranking/tests.
   */
  now?: number;
}

const DAY_MS = 86_400_000;

function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Recency boost in [0, 1] for a row's timestamp column. */
export function recencyBoost(row: Row, signal: RecencySignal, nowMs: number): number {
  const ts = toEpochMs(row[signal.column]);
  if (ts === null || signal.halfLifeDays <= 0) return 0;
  const ageDays = Math.max(0, (nowMs - ts) / DAY_MS);
  return Math.pow(0.5, ageDays / signal.halfLifeDays);
}

/** Saturating reward boost in [0, 1): r / (1 + r) for non-negative reward. */
export function rewardBoost(row: Row, signal: RewardSignal): number {
  const col = signal.column ?? '_reward_total';
  const raw = row[col];
  const r = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r / (1 + r);
}

/**
 * Combined, weighted ranking boost for a row (≥ 0). Multiply a base relevance
 * score by `(1 + rankingBoost(...))` to apply it.
 */
export function rankingBoost(row: Row, opts: RankingOptions): number {
  const now = opts.now ?? Date.now();
  let boost = 0;
  if (opts.recency) boost += opts.recency.weight * recencyBoost(row, opts.recency, now);
  if (opts.reward) boost += opts.reward.weight * rewardBoost(row, opts.reward);
  if (opts.custom) {
    const v = opts.custom.fn(row);
    if (Number.isFinite(v)) boost += opts.custom.weight * Math.max(0, Math.min(1, v));
  }
  return boost;
}
