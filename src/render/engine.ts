import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { RenderResult } from '../types.js';
import { atomicWrite } from './writer.js';
import { resolveEntitySource, truncateContent } from './entity-query.js';

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
    this._renderEntityContexts(outputDir, filesWritten, counters);

    return {
      filesWritten,
      filesSkipped: counters.skipped,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Render all entity context definitions.
   * Mutates `filesWritten` and `counters` in place.
   */
  private _renderEntityContexts(
    outputDir: string,
    filesWritten: string[],
    counters: { skipped: number },
  ): void {
    for (const [table, def] of this._schema.getEntityContexts()) {
      const entityPk = this._schema.getPrimaryKey(table)[0] ?? 'id';
      const allRows = this._schema.queryTable(this._adapter, table);

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
          : join(outputDir, def.directoryRoot ?? table, slug);

        mkdirSync(entityDir, { recursive: true });

        // Track rendered content strings in definition order.
        // Used for combined file assembly without disk re-reads.
        // Only entries for files that were not omitted are present.
        const renderedFiles = new Map<string, string>();

        for (const [filename, spec] of Object.entries(def.files)) {
          const rows = resolveEntitySource(spec.source, entityRow, entityPk, this._adapter);

          if (spec.omitIfEmpty && rows.length === 0) continue;

          const content = truncateContent(spec.render(rows), spec.budget);
          renderedFiles.set(filename, content);

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
            const combinedPath = join(entityDir, def.combined.outputFile);
            if (atomicWrite(combinedPath, parts.join('\n\n---\n\n'))) {
              filesWritten.push(combinedPath);
            } else {
              counters.skipped++;
            }
          }
        }
      }
    }
  }
}
