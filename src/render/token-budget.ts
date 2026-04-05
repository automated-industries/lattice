import type { Row } from '../types.js';

/**
 * Estimate the number of tokens in a string using a fast heuristic.
 * Uses ~4 characters per token, a reasonable approximation for English
 * text with typical LLM tokenizers (BPE/ByteBPE).
 *
 * Users who need exact counts should pre-process with their own tokenizer
 * and use the `filter` hook to manually limit rows.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Apply a token budget to rendered output.
 * If the full render exceeds the budget, rows are sorted by priority,
 * pruned via binary search, and re-rendered. A truncation footer is
 * appended so the consuming agent knows context was limited.
 *
 * @returns Final content string, possibly with truncation footer.
 */
export function applyTokenBudget(
  rows: Row[],
  renderFn: (rows: Row[]) => string,
  budget: number,
  prioritizeBy?: string | ((a: Row, b: Row) => number),
): string {
  const fullContent = renderFn(rows);
  if (estimateTokens(fullContent) <= budget) return fullContent;
  if (rows.length === 0) return fullContent;

  // Sort rows by priority (highest priority first)
  const prioritized = [...rows];
  if (typeof prioritizeBy === 'function') {
    prioritized.sort(prioritizeBy);
  } else if (typeof prioritizeBy === 'string') {
    const col = prioritizeBy;
    prioritized.sort((a, b) => {
      const va = a[col];
      const vb = b[col];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return 1;
      if (va > vb) return -1;
      return 0;
    });
  }

  // Binary search for the max number of rows that fits within budget
  let lo = 0;
  let hi = prioritized.length;
  let bestContent = '';
  let bestCount = 0;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const content = renderFn(prioritized.slice(0, mid));
    if (estimateTokens(content) <= budget) {
      bestContent = content;
      bestCount = mid;
      lo = mid;
      if (lo === hi) break;
    } else {
      hi = mid - 1;
    }
  }

  if (bestCount === 0) {
    bestContent = renderFn([]);
  }

  const tokens = estimateTokens(bestContent);
  return (
    bestContent +
    `\n\n[truncated: ${bestCount} of ${rows.length} rows rendered, ~${tokens} tokens]`
  );
}
