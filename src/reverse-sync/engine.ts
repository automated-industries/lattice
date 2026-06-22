import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { ReverseSyncResult } from '../types.js';
import type { LatticeManifest, EntityFileManifestInfo } from '../lifecycle/manifest.js';
import { contentHash, rowVersionHash } from '../render/writer.js';
import type { ReverseSyncUpdate } from '../schema/entity-context.js';
import type { Row } from '../types.js';
import { deriveUpdatesFromFile } from './default-reverse-sync.js';

/**
 * Options for {@link ReverseSyncEngine.process}.
 *
 * With no options the engine keeps its original behavior: only files with a
 * hand-written `reverseSync` are processed, and updates are applied via raw SQL.
 * The GUI file-loopback passes `apply` (to route writes through the changelog
 * path so a file edit is version-controlled exactly like a GUI edit) and
 * `useDefault` (to round-trip frontmatter + body `key: value` fields for files
 * that have no hand-written `reverseSync`).
 */
export interface ReverseSyncProcessOptions {
  /** Apply each update through a changelog-aware path instead of raw SQL. */
  apply?: (update: ReverseSyncUpdate) => Promise<void>;
  /** Derive updates for files lacking a hand-written `reverseSync`. */
  useDefault?: boolean;
  /** Called when a changed file produced no importable update (free-form/custom render). */
  onSkip?: (info: { table: string; slug: string; filename: string; filePath: string }) => void;
}

/**
 * Reverse-sync engine: detects external modifications to rendered entity context
 * files and sweeps the changes back into the database before the next render.
 *
 * Compares current file content hash against the last-rendered hash stored in
 * the manifest to detect changes (which also suppresses render echoes — a
 * render-written file matches its manifest hash and is skipped).
 */
export class ReverseSyncEngine {
  private readonly _schema: SchemaManager;
  private readonly _adapter: StorageAdapter;

  constructor(schema: SchemaManager, adapter: StorageAdapter) {
    this._schema = schema;
    this._adapter = adapter;
  }

  /**
   * Scan all entity context files for external modifications and apply
   * reverse-sync updates to the database.
   *
   * @param outputDir - Root output directory where entity files live.
   * @param prevManifest - The manifest from the previous render cycle (contains hashes).
   * @param dryRun - When true, detect changes but do not modify the database.
   * @returns Summary of what was scanned, changed, and applied.
   */
  async process(
    outputDir: string,
    prevManifest: LatticeManifest | null,
    dryRun = false,
    opts: ReverseSyncProcessOptions = {},
  ): Promise<ReverseSyncResult> {
    const result: ReverseSyncResult = {
      filesScanned: 0,
      filesChanged: 0,
      updatesApplied: 0,
      errors: [],
      conflicts: [],
    };

    if (!prevManifest) return result;

    for (const [table, def] of this._schema.getEntityContexts()) {
      const manifestEntry = prevManifest.entityContexts[table];
      if (!manifestEntry) continue;

      // Effective reverse-sync fn per file: a hand-written `spec.reverseSync`
      // wins; otherwise the default frontmatter+body derivation when enabled.
      // Files with neither are left untouched.
      const pkCols = this._schema.getPrimaryKey(table);
      const fileFns = new Map<string, (content: string, row: Row) => ReverseSyncUpdate[]>();
      for (const [filename, spec] of Object.entries(def.files)) {
        if (spec.reverseSync) {
          fileFns.set(filename, spec.reverseSync);
        } else if (opts.useDefault) {
          fileFns.set(filename, (content, row) =>
            deriveUpdatesFromFile(content, row, { table, pkCols }),
          );
        }
      }
      if (fileFns.size === 0) continue;

      // Build slug → entityRow map for this table
      const allRows = await this._schema.queryTable(this._adapter, table);
      const slugToRow = new Map<string, import('../types.js').Row>();
      for (const row of allRows) {
        slugToRow.set(def.slug(row), row);
      }

      const directoryRoot = manifestEntry.directoryRoot;

      // Iterate over entities in the manifest
      for (const [slug, entityFilesRaw] of Object.entries(manifestEntry.entities)) {
        const entityRow = slugToRow.get(slug);
        if (!entityRow) continue; // Entity deleted since last render — skip

        const entityDir = def.directory
          ? join(outputDir, def.directory(entityRow))
          : join(outputDir, directoryRoot, slug);

        // A legacy v1 entry (bare filename array) has no content hashes, so there
        // is no baseline to compare a file against — treat it as no-baseline and
        // skip the entity. The next render rewrites it in the v2 (hashed) shape.
        if (Array.isArray(entityFilesRaw)) continue;
        const entityFiles: Record<string, EntityFileManifestInfo> = entityFilesRaw;

        for (const [filename, reverseSyncFn] of fileFns) {
          const fileInfo = entityFiles[filename];
          if (!fileInfo) continue; // File wasn't written last render (omitIfEmpty)

          // Skip if no baseline hash (v1 manifests have empty hashes)
          if (!fileInfo.hash) continue;

          const filePath = join(entityDir, filename);
          result.filesScanned++;

          if (!existsSync(filePath)) continue; // File deleted externally — skip

          let currentContent: string;
          try {
            currentContent = readFileSync(filePath, 'utf8');
          } catch {
            continue; // Unreadable — skip
          }

          const currentHash = contentHash(currentContent);
          if (currentHash === fileInfo.hash) continue; // Unchanged — skip

          // File has been modified externally
          result.filesChanged++;

          // Optimistic-concurrency gate: if the DB row changed since the render
          // that produced this manifest entry, applying the file edit would
          // silently overwrite that concurrent DB/cloud change. Reject + report
          // it instead — never clobber. Skipped when the manifest predates
          // rowVersion (older render), falling back to the prior apply behavior
          // until the next render re-captures it.
          if (
            fileInfo.rowVersion !== undefined &&
            rowVersionHash(entityRow) !== fileInfo.rowVersion
          ) {
            result.conflicts.push({
              table,
              slug,
              filename,
              reason: 'db-row-changed-since-render',
            });
            continue;
          }

          try {
            const updates: ReverseSyncUpdate[] = reverseSyncFn(currentContent, entityRow);
            if (updates.length === 0) {
              // Changed on disk but nothing round-trippable parsed out (free-form
              // prose / custom render). Never guess — surface it, don't corrupt.
              opts.onSkip?.({ table, slug, filename, filePath });
              continue;
            }

            if (!dryRun) {
              if (opts.apply) {
                for (const update of updates) await opts.apply(update);
              } else {
                await this._applyUpdates(updates);
              }
            }
            result.updatesApplied += updates.length;
          } catch (err) {
            result.errors.push({
              file: filePath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // If we applied updates and this is not a dry run, refresh the slug map
      // (the render phase that follows will use the updated DB state)
    }

    return result;
  }

  /**
   * Apply a batch of ReverseSyncUpdate to the database.
   * Each update is an independent UPDATE statement.
   * Wrapped in a transaction for atomicity via `adapter.withClient(fn)` so
   * every UPDATE in the batch lands on the same upstream connection — under
   * `pg.Pool`-backed adapters, raw `adapter.run('BEGIN')` calls would
   * otherwise land on different pool connections and break atomicity.
   */
  private async _applyUpdates(updates: ReverseSyncUpdate[]): Promise<void> {
    if (!this._adapter.withClient) {
      throw new Error(
        'ReverseSyncEngine: adapter does not implement withClient — cannot guarantee transactional atomicity for reverse-sync updates',
      );
    }
    await this._adapter.withClient(async (tx) => {
      for (const update of updates) {
        // Computed columns are DERIVED and immutable on the way back: an external
        // edit to a rendered computed value must not overwrite the stored column
        // (it is recomputed from its dependencies on the next write). Redact them
        // from the reverse-sync write so the rendered file can show the value
        // without it becoming a writable field.
        const computed = new Set(
          Object.keys(this._schema.getTables().get(update.table)?.computed ?? {}),
        );
        const setCols = Object.keys(update.set).filter((c) => !computed.has(c));
        if (setCols.length === 0) continue;

        const pkCols = Object.keys(update.pk);
        if (pkCols.length === 0) continue;

        // Validate column and table names (prevent injection)
        const colPattern = /^[a-zA-Z0-9_]+$/;
        if (!colPattern.test(update.table)) {
          throw new Error(`Invalid table name in reverse-sync update: ${update.table}`);
        }
        for (const col of [...setCols, ...pkCols]) {
          if (!colPattern.test(col)) {
            throw new Error(`Invalid column name in reverse-sync update: ${col}`);
          }
        }

        const setClause = setCols.map((c) => `"${c}" = ?`).join(', ');
        const whereClause = pkCols.map((c) => `"${c}" = ?`).join(' AND ');
        const sql = `UPDATE "${update.table}" SET ${setClause} WHERE ${whereClause}`;

        const params = [...setCols.map((c) => update.set[c]), ...pkCols.map((c) => update.pk[c])];

        await tx.run(sql, params);
      }
    });
  }
}
