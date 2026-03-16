import { readFileSync, statSync, existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import type { WritebackDefinition } from '../types.js';

interface FileState {
  offset: number;
  size: number;
}

export class WritebackPipeline {
  private readonly _definitions: WritebackDefinition[] = [];
  private readonly _fileState = new Map<string, FileState>();
  private readonly _seen = new Map<string, Set<string>>();

  define(def: WritebackDefinition): void {
    this._definitions.push(def);
  }

  async process(): Promise<number> {
    let total = 0;
    for (const def of this._definitions) {
      total += await this._processDef(def);
    }
    return total;
  }

  private async _processDef(def: WritebackDefinition): Promise<number> {
    const paths = await this._expandGlob(def.file);
    let processed = 0;

    for (const filePath of paths) {
      if (!existsSync(filePath)) continue;

      const stat = statSync(filePath);
      const currentSize = stat.size;
      const state = this._fileState.get(filePath) ?? { offset: 0, size: 0 };

      // Detect truncation/rotation
      if (currentSize < state.size) {
        this._fileState.set(filePath, { offset: 0, size: 0 });
        state.offset = 0;
      }

      if (currentSize === state.offset) continue;

      const content = readFileSync(filePath, 'utf8');
      const { entries, nextOffset } = def.parse(content, state.offset);

      this._fileState.set(filePath, { offset: nextOffset, size: currentSize });

      for (const entry of entries) {
        const key = def.dedupeKey ? def.dedupeKey(entry) : null;

        if (key !== null) {
          const seenForFile = this._seen.get(filePath) ?? new Set<string>();
          if (seenForFile.has(key)) continue;
          seenForFile.add(key);
          this._seen.set(filePath, seenForFile);
        }

        await def.persist(entry, filePath);
        processed++;
      }
    }

    return processed;
  }

  private async _expandGlob(pattern: string): Promise<string[]> {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return [pattern];
    }
    const results: string[] = [];
    for await (const file of glob(pattern)) {
      results.push(file);
    }
    return results;
  }
}
