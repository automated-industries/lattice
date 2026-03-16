import { join } from 'node:path';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { RenderResult } from '../types.js';
import { atomicWrite } from './writer.js';

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
    let filesSkipped = 0;

    // Single-table renders
    for (const [name, def] of this._schema.getTables()) {
      let rows = this._schema.queryTable(this._adapter, name);
      if (def.filter) rows = def.filter(rows);
      const content = def.render(rows);
      const filePath = join(outputDir, def.outputFile);
      const written = atomicWrite(filePath, content);
      if (written) {
        filesWritten.push(filePath);
      } else {
        filesSkipped++;
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
        const written = atomicWrite(filePath, content);
        if (written) {
          filesWritten.push(filePath);
        } else {
          filesSkipped++;
        }
      }
    }

    return {
      filesWritten,
      filesSkipped,
      durationMs: Date.now() - start,
    };
  }
}
