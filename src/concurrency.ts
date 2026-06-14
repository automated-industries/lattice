/**
 * Map over items with a bounded number of in-flight async calls. Order-
 * preserving (result[i] corresponds to items[i]). Bounding matters in two
 * places: the GUI's per-entity count fan-out (a ~95-entity schema once fired 95
 * concurrent COUNT(*)s and exhausted the Postgres session pooler), and the
 * render engine's per-table fan-out (each table loads its whole row set, so an
 * unbounded fan-out would multiply peak memory + DB egress).
 *
 * Lives at the package root (not under `gui/` or `render/`) so both layers can
 * import it without inverting the `gui → render` dependency direction.
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
