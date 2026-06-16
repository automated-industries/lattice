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
