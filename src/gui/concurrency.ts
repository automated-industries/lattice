/**
 * Map over items with a bounded number of in-flight async calls. Order-
 * preserving (result[i] corresponds to items[i]). Used so the GUI's per-entity
 * count fan-out can't open more DB connections than a small cap — a schema with
 * ~95 entities previously fired 95 concurrent COUNT(*)s and exhausted the
 * Postgres session pooler (EMAXCONN).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
