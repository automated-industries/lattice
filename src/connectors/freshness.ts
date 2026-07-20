/**
 * On-ACCESS connector freshness. A connector table (MCP-synced, external-DB, …) is a local
 * mirror; reading it should pull a recent-enough copy without blocking the read.
 * {@link touchConnectorTable} fires a THROTTLED, stale-gated background refresh when such a table
 * is accessed. It is wired on the dashboard SQL-read path (`POST /api/analytics/sql`) — i.e. a
 * dashboard tile render or an ad-hoc SQL-runner query that references the table — which, with the
 * on-LOAD `sync-if-stale` pass, is the intended coverage; plain table-grid browsing is not a
 * trigger.
 *
 * Bounded by design (external sources share one egress budget): at most one sync per connection
 * per throttle window, and only when the connection is older than the on-access staleness window. This is
 * strictly narrower than the on-LOAD `sync-if-stale` pass (which uses a longer window); the two
 * compose — load refreshes everything on a long cadence, access refreshes the touched table on a
 * short one. Best-effort + fire-and-forget: a failed background sync must NEVER fail the read.
 */

import type { Lattice } from '../lattice.js';
import type { Connector } from './types.js';
import { listConnectors } from './registry.js';
import { syncIfStale } from './sync.js';

/** On-access staleness window — refresh the touched connection only when older than this. */
const ACCESS_STALE_MS = 5 * 60 * 1000;
/** Never re-trigger a background refresh for the same connection within this window: a burst of
 *  queries against a connector table causes at most one source sync (bounded egress). */
const TRIGGER_THROTTLE_MS = 60 * 1000;

// connectionId → last time a background refresh was TRIGGERED (not completed). Process-local,
// which is the right scope: it only rate-limits this process's own read-driven syncs.
const lastTrigger = new Map<string, number>();

/**
 * If `table` is backed by a connector, kick a throttled, stale-gated background refresh of that
 * connection. Fire-and-forget: returns immediately; the read is never blocked or failed by it.
 * `now` is injectable for tests (defaults to the wall clock).
 *
 * LOCAL (SQLite) workspaces only — connectors are a per-machine feature and the identity stamp
 * is meaningless locally (mirrors `reregister` / `describeConnectedSources`). On a cloud (Postgres)
 * workspace, per-member scoping is required and access-refresh is left to the identity-scoped
 * on-load `sync-if-stale` pass, so this is a no-op there.
 */
export async function touchConnectorTable(
  db: Lattice,
  connectors: Connector[],
  table: string,
  now: number = Date.now(),
): Promise<void> {
  if (db.getDialect() === 'postgres') return; // cloud: on-load sync-if-stale handles it, scoped
  const source = db.getConnectedSource(table);
  if (!source) return; // authored/native table — nothing to refresh
  try {
    await refreshIfDue(db, connectors, source.toolkit, now);
  } catch {
    /* best-effort — the read already returned; a stale background sync must never fail a query */
  }
}

async function refreshIfDue(
  db: Lattice,
  connectors: Connector[],
  toolkit: string,
  now: number,
): Promise<void> {
  const rows = (await listConnectors(db)).filter(
    (c) => c.toolkit === toolkit && c.status !== 'disconnected',
  );
  for (const rec of rows) {
    const connector = connectors.find((c) => c.connector === rec.connector);
    if (!connector) {
      // A connected row whose connector implementation isn't in the set we were handed. Do NOT
      // silently skip: that hides a wiring gap (an on-access refresh that never fires because the
      // caller passed the wrong connector set). Surface it, and do NOT stamp the throttle — so
      // once the wiring is corrected, the very next touch refreshes rather than being rate-limited.
      console.warn(
        `[connectors] on-access refresh has no connector implementation for kind '${rec.connector}' (connection ${rec.id}); its table was left un-refreshed`,
      );
      continue;
    }
    const key = rec.connectionRef ?? rec.id;
    const prev = lastTrigger.get(key);
    if (prev !== undefined && now - prev < TRIGGER_THROTTLE_MS) continue; // recently triggered
    lastTrigger.set(key, now);
    await syncIfStale(db, connector, rec.id, ACCESS_STALE_MS);
  }
}

/** Test seam: clear the throttle memo. */
export function _resetConnectorFreshness(): void {
  lastTrigger.clear();
}
