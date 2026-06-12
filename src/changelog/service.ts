import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync, getAsyncOrSync, runAsyncOrSync } from '../db/adapter.js';
import type { Row, ChangeEntry } from '../types.js';

/**
 * Changelog read/replay operations extracted from the `Lattice` facade. The
 * facade keeps the public methods (`history`, `recentChanges`, `rollback`,
 * `snapshot`, `diff`) — they perform the `init()` guard and delegate here. This
 * collaborator owns the SQL + replay logic over `__lattice_changelog`.
 *
 * Dependencies that live on the facade (the adapter, the composite-PK WHERE
 * builder, and the changelog-append writer) are injected so this module never
 * reaches back into `Lattice` internals.
 */

/** Structural shape of `Lattice`'s `PkLookup` (avoids a circular import). */
type PkLookup = string | Record<string, unknown>;

/** Deserialize the `source_ref` column (a JSON array of source ids) back to a
 *  string[]. NULL (plain edits + pre-3.0 rows) and any malformed value → null,
 *  so a bad row never throws on read. */
function parseSourceRef(raw: unknown): string[] | null {
  if (raw == null || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

export interface ChangelogServiceDeps {
  adapter: StorageAdapter;
  pkWhere: (table: string, id: PkLookup) => { clause: string; params: unknown[] };
  appendChangelog: (
    table: string,
    rowId: string,
    operation: 'insert' | 'update' | 'delete' | 'rollback',
    changes: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
    source?: string,
    reason?: string,
  ) => Promise<void>;
}

export class ChangelogService {
  private readonly adapter: StorageAdapter;
  private readonly pkWhere: ChangelogServiceDeps['pkWhere'];
  private readonly appendChangelog: ChangelogServiceDeps['appendChangelog'];

  constructor(deps: ChangelogServiceDeps) {
    this.adapter = deps.adapter;
    this.pkWhere = deps.pkWhere;
    this.appendChangelog = deps.appendChangelog;
  }

  /** Parse a raw changelog DB row into a ChangeEntry. */
  private parseChangeEntry(row: Row): ChangeEntry {
    return {
      id: row.id as string,
      table: row.table_name as string,
      rowId: row.row_id as string,
      operation: row.operation as ChangeEntry['operation'],
      changes: row.changes ? (JSON.parse(row.changes as string) as Record<string, unknown>) : null,
      previous: row.previous
        ? (JSON.parse(row.previous as string) as Record<string, unknown>)
        : null,
      source: row.source != null ? (row.source as string) : null,
      reason: row.reason != null ? (row.reason as string) : null,
      createdAt: row.created_at as string,
      sourceRef: parseSourceRef(row.source_ref),
      changeKind: row.change_kind != null ? (row.change_kind as 'ground_truth' | 'derived') : null,
    };
  }

  /** Insertion-order expression, newest first. SQLite has `rowid`; Postgres has
   *  no such pseudo-column, so order by the explicit `created_at` (+ `id` for a
   *  deterministic tiebreak) — both are stamped on every write. */
  private get _orderDesc(): string {
    return this.adapter.dialect === 'postgres' ? 'created_at DESC, id DESC' : 'rowid DESC';
  }

  /** Get change history for a specific row, newest first. */
  async history(table: string, id: string, opts?: { limit?: number }): Promise<ChangeEntry[]> {
    const limit = opts?.limit ?? 100;
    const rows = await allAsyncOrSync(
      this.adapter,
      `SELECT * FROM __lattice_changelog
       WHERE table_name = ? AND row_id = ?
       ORDER BY ${this._orderDesc}
       LIMIT ?`,
      [table, id, limit],
    );
    return rows.map((r) => this.parseChangeEntry(r));
  }

  /** Get recent changes across tables. */
  async recentChanges(opts?: {
    table?: string;
    since?: string;
    limit?: number;
  }): Promise<ChangeEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts?.table) {
      clauses.push('table_name = ?');
      params.push(opts.table);
    }
    if (opts?.since) {
      clauses.push('created_at >= ?');
      params.push(opts.since);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;

    const rows = await allAsyncOrSync(
      this.adapter,
      `SELECT * FROM __lattice_changelog ${where}
       ORDER BY ${this._orderDesc}
       LIMIT ?`,
      [...params, limit],
    );
    return rows.map((r) => this.parseChangeEntry(r));
  }

  /**
   * Rollback a specific change by applying the inverse operation.
   * The rollback itself is recorded as a new changelog entry.
   */
  async rollback(changeId: string): Promise<void> {
    const entry = await getAsyncOrSync(
      this.adapter,
      `SELECT * FROM __lattice_changelog WHERE id = ?`,
      [changeId],
    );
    if (!entry) {
      throw new Error(`Lattice: changelog entry "${changeId}" not found`);
    }

    const parsed = this.parseChangeEntry(entry);
    const { clause, params: pkParams } = this.pkWhere(parsed.table, parsed.rowId);

    switch (parsed.operation) {
      case 'insert':
        // Undo insert → delete the row
        await runAsyncOrSync(
          this.adapter,
          `DELETE FROM "${parsed.table}" WHERE ${clause}`,
          pkParams,
        );
        break;

      case 'update':
        // Undo update → restore previous values
        if (!parsed.previous) {
          throw new Error(
            `Lattice: changelog entry "${changeId}" has no previous values to restore`,
          );
        }
        {
          const setCols = Object.keys(parsed.previous)
            .map((c) => `"${c}" = ?`)
            .join(', ');
          await runAsyncOrSync(
            this.adapter,
            `UPDATE "${parsed.table}" SET ${setCols} WHERE ${clause}`,
            [...Object.values(parsed.previous), ...pkParams],
          );
        }
        break;

      case 'delete':
        // Undo delete → re-insert the row
        if (!parsed.previous) {
          throw new Error(`Lattice: changelog entry "${changeId}" has no previous row to restore`);
        }
        {
          const cols = Object.keys(parsed.previous)
            .map((c) => `"${c}"`)
            .join(', ');
          const placeholders = Object.keys(parsed.previous)
            .map(() => '?')
            .join(', ');
          await runAsyncOrSync(
            this.adapter,
            `INSERT INTO "${parsed.table}" (${cols}) VALUES (${placeholders})`,
            Object.values(parsed.previous),
          );
        }
        break;

      default:
        throw new Error(`Lattice: cannot rollback operation "${parsed.operation}"`);
    }

    // Record the rollback as a new changelog entry
    await this.appendChangelog(
      parsed.table,
      parsed.rowId,
      'rollback',
      parsed.previous, // The values we restored to become the "changes"
      parsed.changes, // The values we undid become the "previous"
      'system',
      `rollback of ${changeId}`,
    );
  }

  /** Show field-level diff between two changelog entries for the same row. */
  diff(
    table: string,
    id: string,
    fromChangeId: string,
    toChangeId: string,
  ): Promise<Record<string, { old: unknown; new: unknown }>> {
    const fromSnap = this.snapshot(table, id, fromChangeId);
    const toSnap = this.snapshot(table, id, toChangeId);

    return Promise.all([fromSnap, toSnap]).then(([fromState, toState]) => {
      const result: Record<string, { old: unknown; new: unknown }> = {};
      const allKeys = new Set([...Object.keys(fromState), ...Object.keys(toState)]);
      for (const key of allKeys) {
        const oldVal = fromState[key];
        const newVal = toState[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          result[key] = { old: oldVal ?? null, new: newVal ?? null };
        }
      }
      return result;
    });
  }

  /**
   * Reconstruct the row state at a specific changelog entry by replaying
   * all operations up to and including that entry.
   */
  async snapshot(table: string, id: string, changeId: string): Promise<Record<string, unknown>> {
    const pg = this.adapter.dialect === 'postgres';
    // Replay up to + including the target entry, in insertion order. SQLite keys
    // that order on `rowid`; Postgres has none, so it keys on (created_at, id).
    const target = await getAsyncOrSync(
      this.adapter,
      `SELECT ${pg ? 'created_at, id' : 'rowid'} FROM __lattice_changelog WHERE id = ?`,
      [changeId],
    );
    if (!target) {
      throw new Error(`Lattice: changelog entry "${changeId}" not found`);
    }

    const entries = pg
      ? await allAsyncOrSync(
          this.adapter,
          `SELECT * FROM __lattice_changelog
           WHERE table_name = ? AND row_id = ? AND (created_at, id) <= (?, ?)
           ORDER BY created_at ASC, id ASC`,
          [table, id, target.created_at, target.id],
        )
      : await allAsyncOrSync(
          this.adapter,
          `SELECT * FROM __lattice_changelog
           WHERE table_name = ? AND row_id = ? AND rowid <= ?
           ORDER BY rowid ASC`,
          [table, id, target.rowid],
        );

    // Replay to build state
    let state: Record<string, unknown> = {};
    for (const raw of entries) {
      const entry = this.parseChangeEntry(raw);
      switch (entry.operation) {
        case 'insert':
          state = { ...state, ...(entry.changes ?? {}) };
          break;
        case 'update':
          state = { ...state, ...(entry.changes ?? {}) };
          break;
        case 'delete':
          state = {};
          break;
        case 'rollback':
          // Rollback restores the "changes" field (which holds what was restored)
          state = { ...state, ...(entry.changes ?? {}) };
          break;
      }
    }
    return state;
  }
}
