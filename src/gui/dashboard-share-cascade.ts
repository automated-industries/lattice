import type { Lattice } from '../lattice.js';
import { allAsyncOrSync, getAsyncOrSync } from '../db/adapter.js';
import { shareTable } from '../cloud/members.js';
import { extractSourceTables } from './dashboard-row.js';

/**
 * Cascade a dashboard share to its underlying data.
 *
 * When a dashboard row is shared with an audience, the tables its page READS (its
 * `source_tables`) must be visible to that same audience — otherwise the shared
 * dashboard renders empty for the recipients, whose RLS filters out every row they
 * were never granted. This grants a standing TABLE-LEVEL share of each dependency
 * table to the dashboard's audience, scoped to the sharer's OWN rows
 * (`lattice_share_table` is owner-keyed), so it can never expose another member's
 * private rows in a shared table. It covers rows added later too (the share is read
 * live by the visibility predicate), so a shared dashboard stays populated as its
 * data grows — no re-share needed.
 *
 * One-way by construction: callers invoke this ONLY when a dashboard becomes MORE
 * shared (visible to everyone, or newly granted to specific people) — never on
 * unshare/revoke — and `lattice_share_table` only ever widens, so unsharing a
 * dashboard leaves the underlying data shared (the intended product behavior).
 *
 * Cloud-only (Postgres). Skips dependencies that can't or shouldn't be cascaded:
 * the `dashboards` table itself (sharing it would leak every dashboard), internal
 * bookkeeping tables, tables that aren't registered, and never-share tables
 * (secrets / chat-class) — the last are reported as `skipped`, not shared.
 */
export async function cascadeDashboardDataShare(
  db: Lattice,
  dashboardPk: string,
  audience: 'everyone' | 'custom',
  grantees: readonly string[] = [],
): Promise<{ shared: string[]; skipped: string[] }> {
  if (db.getDialect() !== 'postgres') return { shared: [], skipped: [] };

  // The dependency tables the dashboard reads: prefer the persisted `source_tables`,
  // fall back to re-deriving from the page HTML for a dashboard saved before that
  // column was recorded. The sharer owns the dashboard row, so it reads back under
  // their own connection regardless of RLS.
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "source_tables", "html" FROM "dashboards" WHERE "id" = ? LIMIT 1`,
    [dashboardPk],
  )) as { source_tables?: string | null; html?: string | null } | undefined;
  if (!row) return { shared: [], skipped: [] };

  let deps: string[] = [];
  if (typeof row.source_tables === 'string' && row.source_tables) {
    try {
      const parsed = JSON.parse(row.source_tables) as unknown;
      if (Array.isArray(parsed)) deps = parsed.map((t) => String(t));
    } catch {
      deps = [];
    }
  }
  if (deps.length === 0 && typeof row.html === 'string' && row.html) {
    deps = extractSourceTables(row.html) ?? [];
  }

  // Real user tables only — never the dashboards table itself (would share every
  // dashboard) and never internal bookkeeping (names begin with "_").
  const named = [...new Set(deps)].filter((t) => t !== 'dashboards' && !t.startsWith('_'));
  if (named.length === 0) return { shared: [], skipped: [] };
  // Keep only names that resolve to a REAL table. Checked against the database
  // itself (to_regclass is name resolution, not an access check, so it is
  // authoritative on ANY connection) rather than the ORM's registered-table set —
  // a scoped member's registration can be incomplete, which would otherwise make
  // the cascade silently share nothing when a member shares their own dashboard.
  const existing = (await allAsyncOrSync(
    db.adapter,
    `SELECT t FROM unnest(?::text[]) AS t WHERE to_regclass(quote_ident(t)) IS NOT NULL`,
    [named],
  )) as { t: string }[];
  const candidates = existing.map((r) => r.t);
  if (candidates.length === 0) return { shared: [], skipped: [] };

  // Never-share tables can't be shared — skip them explicitly instead of letting
  // lattice_share_table raise and abort the whole cascade for the other deps. This
  // MUST go through the member-callable DEFINER function, not a direct read of the
  // owner-only __lattice_table_policy: a scoped member has no grant on that table,
  // so a direct read raises "permission denied" and breaks member-owned shares.
  const neverShareRows = (await allAsyncOrSync(
    db.adapter,
    `SELECT "table_name" FROM lattice_never_share_tables(?::text[])`,
    [candidates],
  )) as { table_name: string }[];
  const neverShare = new Set(neverShareRows.map((r) => r.table_name));

  const shared: string[] = [];
  const skipped: string[] = [];
  for (const t of candidates) {
    if (neverShare.has(t)) {
      skipped.push(t);
      continue;
    }
    await shareTable(db, t, audience, grantees);
    shared.push(t);
  }
  return { shared, skipped };
}
