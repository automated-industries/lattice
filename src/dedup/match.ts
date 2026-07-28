/**
 * Fuzzy text matching for near-duplicate detection. Deterministic, generic CS
 * (Sørensen–Dice coefficient over character bigrams) — no external services, no
 * model calls. Used to surface "possible duplicates" like "Avista" vs
 * "Avista Utilities" that exact-match grouping misses.
 */

/** Default similarity at/above which two strings are treated as a near-duplicate. */
export const DEFAULT_NEAR_THRESHOLD = 0.82;

/** Character bigrams (2-char shingles) of a string, as a multiset count map. */
function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * A string's bigram multiset, computed once so pairwise scoring over the same
 * item does not rebuild the map for every pair (the naive per-pair rebuild is
 * what made large candidate blocks quadratically expensive in wall-clock, not
 * just in pair count).
 */
export interface BigramProfile {
  /** The source text, kept for the exact-equality fast path. */
  text: string;
  /** Bigram multiset counts. */
  grams: Map<string, number>;
  /** Total bigram count (= text.length − 1, or 0 for texts shorter than 2). */
  total: number;
}

/** Build a reusable {@link BigramProfile} for one string. */
export function bigramProfile(text: string): BigramProfile {
  const grams = text.length < 2 ? new Map<string, number>() : bigrams(text);
  return { text, grams, total: Math.max(0, text.length - 1) };
}

/**
 * Sørensen–Dice over two precomputed profiles. Score-identical to
 * {@link bigramDice} on the same strings — the profile only moves the bigram
 * construction out of the pairwise loop.
 */
export function diceFromProfiles(a: BigramProfile, b: BigramProfile): number {
  if (a.text === b.text) return 1;
  if (a.total === 0 || b.total === 0) return 0;
  // Iterate the smaller multiset — intersection size is bounded by it anyway.
  const [small, large] = a.grams.size <= b.grams.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const [g, countS] of small.grams) {
    const countL = large.grams.get(g);
    if (countL) intersection += Math.min(countS, countL);
  }
  return (2 * intersection) / (a.total + b.total);
}

/**
 * Sørensen–Dice coefficient over character bigrams: `2·|A∩B| / (|A|+|B|)`, in
 * [0, 1]. 1 = identical bigram profiles, 0 = no shared bigrams. Inputs are
 * assumed already normalized (see normalizeText). Strings shorter than 2 chars
 * fall back to exact equality (no bigrams to compare).
 */
export function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let intersection = 0;
  for (const [g, countA] of ga) {
    const countB = gb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

export type PairVerdict = 'exact' | 'near' | 'none';

/**
 * Classify a pair of already-normalized keys as exact (equal), near (Dice ≥
 * threshold), or none.
 */
export function classifyPair(
  a: string,
  b: string,
  threshold = DEFAULT_NEAR_THRESHOLD,
): PairVerdict {
  if (a === b) return 'exact';
  return bigramDice(a, b) >= threshold ? 'near' : 'none';
}
