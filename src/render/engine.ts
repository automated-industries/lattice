import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { RenderResult } from '../types.js';
import { atomicWrite, contentHash } from './writer.js';
import { resolveEntitySource, truncateContent } from './entity-query.js';
import { compileEntityRender } from './entity-templates.js';
import type { EntityContextManifestEntry, LatticeManifest, EntityFileManifestInfo } from '../lifecycle/manifest.js';
import { entityFileNames, writeManifest } from '../lifecycle/manifest.js';
import type { CleanupOptions, CleanupResult } from '../lifecycle/cleanup.js';
import { cleanupEntityContexts } from '../lifecycle/cleanup.js';

export class RenderEngine {
  private readonly _schema: SchemaManager;
  private readonly _adapter: StorageAdapter;

  constructor(schema: SchemaManager, adapter: StorageAdapter) {
    this._schema = schema;
    this._adapter = adapter;
  }

  async render(outputDir: string): Promise<RenderResult> {
    const start = Date.now();
    const filesWritten: string[] = [];
    const counters = { skipped: 0 };

    // Single-table renders
    for (const [name, def] of this._schema.getTables()) {
      let rows = this._schema.queryTable(this._adapter, name);
      if (def.filter) rows = def.filter(rows);
      const content = def.render(rows);
      const filePath = join(outputDir, def.outputFile);
      if (atomicWrite(filePath, content)) {
        filesWritten.push(filePath);
      } else {
        counters.skipped++;
      }
    }

    // Multi-table renders
    for (const [, def] of this._schema.getMultis()) {
      const keys = await def.keys();
      const tables: Record<string, import('../types.js').Row[]> = {};

      if (def.tables) {
        for (const t of def.tables) {
          tables[t] = this._schema.queryTable(this._adapter, t);
        }
      }

      for (const key of keys) {
        const content = def.render(key, tables);
        const filePath = join(outputDir, def.outputFile(key));
        if (atomicWrite(filePath, content)) {
          filesWritten.push(filePath);
        } else {
          counters.skipped++;
        }
      }
    }

    // Entity context renders
    const entityContextManifest = this._renderEntityContexts(outputDir, filesWritten, counters);

    // Write manifest if there are any entity contexts
    if (this._schema.getEntityContexts().size > 0) {
      writeManifest(outputDir, {
        version: 2,
        generated_at: new Date().toISOString(),
        entityContexts: entityContextManifest,
      });
    }

    return {
      filesWritten,
      filesSkipped: counters.skipped,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run orphan cleanup using the previous manifest.
   * Called by reconcile() and optionally by the watch loop.
   *
   * @param newManifest - Optional: the manifest just written by render().
   *   When provided, step 2 (stale files in surviving entity dirs) compares
   *   old vs new manifest entries, catching omitIfEmpty files that were written
   *   before but skipped in the current render cycle.
   */
  cleanup(
    outputDir: string,
    prevManifest: LatticeManifest | null,
    options: CleanupOptions = {},
    newManifest?: LatticeManifest | null,
  ): CleanupResult {
    const entityContexts = this._schema.getEntityContexts();
    const currentSlugsByTable = new Map<string, Set<string>>();
    for (const [table, def] of entityContexts) {
      const rows = this._schema.queryTable(this._adapter, table);
      const slugs = new Set(rows.map((row) => def.slug(row)));
      currentSlugsByTable.set(table, slugs);
    }
    return cleanupEntityContexts(outputDir, entityContexts, currentSlugsByTable, prevManifest, options, newManifest);
  }

  /**
   * Render all entity context definitions.
   * Mutates `filesWritten` and `counters` in place.
   * Returns manifest data for the entity contexts rendered this cycle.
   */
  private _renderEntityContexts(
    outputDir: string,
    filesWritten: string[],
    counters: { skipped: number },
  ): Record<string, EntityContextManifestEntry> {
    const manifestData: Record<string, EntityContextManifestEntry> = {};

    for (const [table, def] of this._schema.getEntityContexts()) {
      const entityPk = this._schema.getPrimaryKey(table)[0] ?? 'id';
      const allRows = this._schema.queryTable(this._adapter, table);
      const directoryRoot = def.directoryRoot ?? table;

      const manifestEntry: EntityContextManifestEntry = {
        directoryRoot,
        ...(def.index ? { indexFile: def.index.outputFile } : {}),
        declaredFiles: Object.keys(def.files),
        protectedFiles: def.protectedFiles ?? [],
        entities: {},
      };

      // --- index file ---
      if (def.index) {
        const indexPath = join(outputDir, def.index.outputFile);
        if (atomicWrite(indexPath, def.index.render(allRows))) {
          filesWritten.push(indexPath);
        } else {
          counters.skipped++;
        }
      }

      // --- per-entity files ---
      for (const entityRow of allRows) {
        const slug = def.slug(entityRow);
        const entityDir = def.directory
          ? join(outputDir, def.directory(entityRow))
          : join(outputDir, directoryRoot, slug);

        mkdirSync(entityDir, { recursive: true });

        // Track rendered content strings in definition order.
        // Used for combined file assembly without disk re-reads.
        // Only entries for files that were not omitted are present.
        const renderedFiles = new Map<string, string>();

        // v2 manifest: track per-file hashes
        const entityFileHashes: Record<string, EntityFileManifestInfo> = {};

        for (const [filename, spec] of Object.entries(def.files)) {
          const mergeDefaults = def.sourceDefaults
            && spec.source.type !== 'self'
            && spec.source.type !== 'custom'
            && spec.source.type !== 'enriched';
          const source = mergeDefaults
            ? { ...def.sourceDefaults, ...spec.source }
            : spec.source;
          const rows = resolveEntitySource(source, entityRow, entityPk, this._adapter);

          if (spec.omitIfEmpty && rows.length === 0) continue;

          const renderFn = compileEntityRender(spec.render);
          const content = truncateContent(renderFn(rows), spec.budget);
          renderedFiles.set(filename, content);
          entityFileHashes[filename] = { hash: contentHash(content) };

          const filePath = join(entityDir, filename);
          if (atomicWrite(filePath, content)) {
            filesWritten.push(filePath);
          } else {
            counters.skipped++;
          }
        }

        // --- combined file ---
        if (def.combined && renderedFiles.size > 0) {
          const excluded = new Set(def.combined.exclude ?? []);
          const parts: string[] = [];

          for (const filename of Object.keys(def.files)) {
            if (!excluded.has(filename) && renderedFiles.has(filename)) {
              parts.push(renderedFiles.get(filename)!);
            }
          }

          if (parts.length > 0) {
            const combinedContent = parts.join('\n\n---\n\n');
            const combinedPath = join(entityDir, def.combined.outputFile);
            if (atomicWrite(combinedPath, combinedContent)) {
              filesWritten.push(combinedPath);
            } else {
              counters.skipped++;
            }
            renderedFiles.set(def.combined.outputFile, combinedContent);
            entityFileHashes[def.combined.outputFile] = { hash: contentHash(combinedContent) };
          }
        }

        // Track what was written for this entity in the manifest (v2: with hashes)
        manifestEntry.entities[slug] = entityFileHashes;
      }

      manifestData[table] = manifestEntry;
    }

    return manifestData;
  }
}
