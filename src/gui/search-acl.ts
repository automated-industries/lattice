import type { Lattice } from '../lattice.js';
import type { FtsResult } from '../search/fts.js';
import { filterVisiblePks } from '../teams/row-access.js';

/**
 * Drop full-text search hits the member may not see. FTS joins straight to
 * the physical tables, so it bypasses the row ACL — every hit must be
 * post-filtered. Shared by the REST `/api/search` route and the assistant's
 * `search` tool so the two stay in lockstep. Groups left with no visible
 * hits are dropped entirely (a denied row is indistinguishable from a
 * missing one).
 */
export async function filterSearchGroupsByAcl(
  db: Lattice,
  teamId: string,
  userId: string,
  result: FtsResult,
): Promise<FtsResult> {
  const groups: FtsResult['groups'] = [];
  for (const group of result.groups) {
    const visible = await filterVisiblePks(
      db,
      teamId,
      group.table,
      userId,
      group.hits.map((h) => h.id),
    );
    const hits = group.hits.filter((h) => visible.has(h.id));
    if (hits.length > 0) groups.push({ ...group, hits, count: hits.length });
  }
  return { ...result, groups };
}
