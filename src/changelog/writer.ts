import type { StorageAdapter } from '../db/adapter.js';
import { getAsyncOrSync, runAsyncOrSync, introspectColumnsAsyncOrSync } from '../db/adapter.js';
import type { ChangeProvenance, ChangelogOptions } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Changelog write/DDL operations extracted from the `Lattice` facade. The
 * facade keeps its private method names (`_changelogTableExists`,
 * `_ensureChangelogTable`, `_appendChangelog`, `_writeChangelogRow`,
 * `_pruneChangelog`) as thin delegators so every existing call site compiles
 * unchanged. This collaborator owns the table existence check, the create/
 * additive-migrate DDL, the gated + ungated INSERTs, and the retention prune
 * over `__lattice_changelog`.
 *
 * Dependencies that live on the facade (the adapter, the dialect accessor, the
 * changelog-enabled gate, and the retention options) are injected so this
 * module never reaches back into `Lattice` internals.
 */

export interface ChangelogWriterDeps {
  adapter: StorageAdapter;
  dialect: () => 'sqlite' | 'postgres';
  isChangelogTable: (table: string) => boolean;
  changelogOptions?: ChangelogOptions | undefined;
}

export class ChangelogWriter {
  private readonly adapter: StorageAdapter;
  private readonly dialect: ChangelogWriterDeps['dialect'];
  private readonly isChangelogTable: ChangelogWriterDeps['isChangelogTable'];
  private readonly changelogOptions?: ChangelogOptions | undefined;

  constructor(deps: ChangelogWriterDeps) {
    this.adapter = deps.adapter;
    this.dialect = deps.dialect;
    this.isChangelogTable = deps.isChangelogTable;
    this.changelogOptions = deps.changelogOptions;
  }

  /** Whether `__lattice_changelog` physically exists (read-only; no DDL), so a
   *  scoped member can decide there are no observations without trying to create
   *  the table. */
  async tableExists(): Promise<boolean> {
    if (this.dialect() === 'postgres') {
      const row = (await getAsyncOrSync(
        this.adapter,
        `SELECT to_regclass('__lattice_changelog') AS reg`,
      )) as { reg?: string | null } | undefined;
      return !!row && row.reg != null;
    }
    const row = (await getAsyncOrSync(
      this.adapter,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='__lattice_changelog'`,
    )) as { name?: string } | undefined;
    return !!row;
  }

  async ensureTable(): Promise<void> {
    // `created_at` default is dialect-specific: SQLite's `strftime` isn't valid
    // Postgres, and a cloud change-log (the per-viewer observation substrate)
    // must create cleanly on Postgres. Both produce a sortable ISO-8601 string;
    // every write also passes `created_at` explicitly (see writeRow),
    // so the default only matters for any out-of-band insert.
    const createdAtDefault =
      this.dialect() === 'postgres'
        ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
    await runAsyncOrSync(
      this.adapter,
      `
      CREATE TABLE IF NOT EXISTS __lattice_changelog (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changes TEXT,
        previous TEXT,
        source TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT ${createdAtDefault},
        source_ref TEXT,
        change_kind TEXT,
        superseded_by TEXT,
        audience TEXT,
        source_sensitive INTEGER NOT NULL DEFAULT 0
      )
    `,
    );
    // Idempotent additive migration for change-logs created before 3.0:
    // introspect the live columns and ALTER in any provenance column that is
    // missing. Each is nullable or defaulted, so existing rows + readers are
    // unaffected. (CREATE TABLE IF NOT EXISTS above only covers fresh DBs.)
    const existing = new Set(
      await introspectColumnsAsyncOrSync(this.adapter, '__lattice_changelog'),
    );
    const additive: [string, string][] = [
      ['source_ref', 'TEXT'],
      ['change_kind', 'TEXT'],
      ['superseded_by', 'TEXT'],
      ['audience', 'TEXT'],
      ['source_sensitive', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, type] of additive) {
      if (!existing.has(col)) {
        await runAsyncOrSync(
          this.adapter,
          `ALTER TABLE __lattice_changelog ADD COLUMN ${col} ${type}`,
        );
      }
    }
    // Monotonic insertion order. SQLite has `rowid` natively; Postgres needs an
    // explicit identity column — ordering by `created_at` alone ties when two
    // entries land in the same millisecond (the uuid `id` is no tiebreak), which
    // corrupts history/replay order. The change feed uses the same pattern.
    if (this.dialect() === 'postgres' && !existing.has('seq')) {
      await runAsyncOrSync(
        this.adapter,
        `ALTER TABLE __lattice_changelog ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY`,
      );
    }
    await runAsyncOrSync(
      this.adapter,
      `
      CREATE INDEX IF NOT EXISTS idx_changelog_row
      ON __lattice_changelog (table_name, row_id, created_at)
    `,
    );
  }

  /** Append a changelog entry if the table has changelog enabled. The optional
   *  `prov` carries the per-viewer observation provenance (source-set, kind,
   *  audience, …); when omitted the entry behaves exactly as a pre-3.0 entry. */
  async append(
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
    prov?: ChangeProvenance,
  ): Promise<void> {
    if (!this.isChangelogTable(table)) return;
    await this.writeRow(table, rowId, operation, changes, previous, source, reason, prov);
  }

  /** The ungated change-log INSERT. `append` wraps it with the
   *  changelog-enabled gate; `observe()` calls it directly (an observation is an
   *  explicit, always-recorded write to the substrate). The change-log table must
   *  exist already. */
  async writeRow(
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
    prov?: ChangeProvenance,
  ): Promise<void> {
    const id = uuidv4();
    // Normalize the source-set to a JSON array string for the source_ref column.
    const sourceRef =
      prov?.sourceRef == null
        ? null
        : JSON.stringify(Array.isArray(prov.sourceRef) ? prov.sourceRef : [prov.sourceRef]);
    // Stamp created_at explicitly so the value + ordering are identical on SQLite
    // and Postgres (the column default differs per dialect; see ensureTable).
    const createdAt = new Date().toISOString();
    await runAsyncOrSync(
      this.adapter,
      `INSERT INTO __lattice_changelog
         (id, table_name, row_id, operation, changes, previous, source, reason,
          source_ref, change_kind, superseded_by, audience, source_sensitive, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        table,
        rowId,
        operation,
        changes ? JSON.stringify(changes) : null,
        previous ? JSON.stringify(previous) : null,
        source ?? null,
        reason ?? prov?.reason ?? null,
        sourceRef,
        prov?.changeKind ?? null,
        prov?.supersededBy ?? null,
        prov?.audience ?? null,
        prov?.sourceSensitive ? 1 : 0,
        createdAt,
      ],
    );
  }

  /** Prune changelog entries based on retention policy. */
  async prune(): Promise<void> {
    const opts = this.changelogOptions;
    if (!opts) return;

    if (opts.retentionDays != null && opts.retentionDays > 0) {
      await runAsyncOrSync(
        this.adapter,
        `DELETE FROM __lattice_changelog
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
        [`-${String(opts.retentionDays)} days`],
      );
    }

    if (opts.maxEntriesPerRow != null && opts.maxEntriesPerRow > 0) {
      // Delete entries beyond the max per (table_name, row_id), keeping the newest
      await runAsyncOrSync(
        this.adapter,
        `DELETE FROM __lattice_changelog WHERE id IN (
           SELECT c.id FROM __lattice_changelog c
           INNER JOIN (
             SELECT table_name, row_id, COUNT(*) as cnt
             FROM __lattice_changelog
             GROUP BY table_name, row_id
             HAVING cnt > ?
           ) g ON c.table_name = g.table_name AND c.row_id = g.row_id
           WHERE c.created_at <= (
             SELECT created_at FROM __lattice_changelog c2
             WHERE c2.table_name = c.table_name AND c2.row_id = c.row_id
             ORDER BY c2.created_at DESC
             LIMIT 1 OFFSET ?
           )
         )`,
        [opts.maxEntriesPerRow, opts.maxEntriesPerRow],
      );
    }
  }
}
