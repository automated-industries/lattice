import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { ReverseSyncResult } from '../types.js';
import type { LatticeManifest, EntityFileManifestInfo } from '../lifecycle/manifest.js';
import { isV1EntityFiles, normalizeEntityFiles } from '../lifecycle/manifest.js';
import { contentHash } from '../render/writer.js';
import type { ReverseSyncUpdate } from '../schema/entity-context.js';

/**
 * Reverse-sync engine: detects external modifications to rendered entity context
 * files and sweeps the changes back into the database before the next render.
 *
 * Only processes files whose {@link EntityFileSpec} includes a `reverseSync` function.
 * Compares current file content hash against the last-rendered hash stored in
 * the manifest to detect changes.
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
  process(
    outputDir: string,
    prevManifest: LatticeManifest | null,
    dryRun = false,
  ): ReverseSyncResult {
    const result: ReverseSyncResult = {
      filesScanned: 0,
      filesChanged: 0,
      updatesApplied: 0,
      errors: [],
    };

    if (!prevManifest) return result;

    for (const [table, def] of this._schema.getEntityContexts()) {
      const manifestEntry = prevManifest.entityContexts[table];
      if (!manifestEntry) continue;

      // Check if any file spec in this entity context has reverseSync
      const reverseSyncFiles = new Map<string, NonNullable<(typeof def.files)[string]['reverseSync']>>();
      for (const [filename, spec] of Object.entries(def.files)) {
        if (spec.reverseSync) {
          reverseSyncFiles.set(filename, spec.reverseSync);
        }
      }
      if (reverseSyncFiles.size === 0) continue;

      // Build slug → entityRow map for this table
      const allRows = this._schema.queryTable(this._adapter, table);
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

        // Normalize v1 → v2 entity files
        const entityFiles: Record<string, EntityFileManifestInfo> = isV1EntityFiles(entityFilesRaw)
          ? normalizeEntityFiles(entityFilesRaw)
          : entityFilesRaw;

        for (const [filename, reverseSyncFn] of reverseSyncFiles) {
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

          try {
            const updates: ReverseSyncUpdate[] = reverseSyncFn(currentContent, entityRow);
            if (updates.length === 0) continue;

            if (!dryRun) {
              this._applyUpdates(updates);
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
   * Wrapped in a transaction for atomicity.
   */
  private _applyUpdates(updates: ReverseSyncUpdate[]): void {
    this._adapter.run('BEGIN');
    try {
      for (const update of updates) {
        const setCols = Object.keys(update.set);
        if (setCols.length === 0) continue;

        const pkCols = Object.keys(update.pk);
        if (pkCols.length === 0) continue;

        // Validate column names (prevent injection)
        const colPattern = /^[a-zA-Z0-9_]+$/;
        for (const col of [...setCols, ...pkCols]) {
          if (!colPattern.test(col)) {
            throw new Error(`Invalid column name in reverse-sync update: ${col}`);
          }
        }

        const setClause = setCols.map((c) => `"${c}" = ?`).join(', ');
        const whereClause = pkCols.map((c) => `"${c}" = ?`).join(' AND ');
        const sql = `UPDATE "${update.table}" SET ${setClause} WHERE ${whereClause}`;

        const params = [
          ...setCols.map((c) => update.set[c]),
          ...pkCols.map((c) => update.pk[c]),
        ];

        this._adapter.run(sql, params);
      }
      this._adapter.run('COMMIT');
    } catch (err) {
      this._adapter.run('ROLLBACK');
      throw err;
    }
  }
}
