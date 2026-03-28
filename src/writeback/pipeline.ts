import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { WritebackDefinition } from '../types.js';
import { InMemoryStateStore } from './state-store.js';
import type { WritebackStateStore } from './state-store.js';

export class WritebackPipeline {
  private readonly _definitions: WritebackDefinition[] = [];
  private _stateStore: WritebackStateStore = new InMemoryStateStore();

  define(def: WritebackDefinition): void {
    if (def.stateStore) {
      this._stateStore = def.stateStore;
    }
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
    const paths = this._expandGlob(def.file);
    let processed = 0;
    const store = def.stateStore ?? this._stateStore;

    for (const filePath of paths) {
      if (!existsSync(filePath)) continue;

      const stat = statSync(filePath);
      const currentSize = stat.size;
      const storedOffset = store.getOffset(filePath);
      const storedSize = store.getSize(filePath);
      let offset = storedOffset;

      // Detect truncation/rotation
      if (currentSize < storedSize) {
        offset = 0;
        store.setOffset(filePath, 0, 0);
      }

      if (currentSize === offset) continue;

      const content = readFileSync(filePath, 'utf8');
      const { entries, nextOffset } = def.parse(content, offset);

      store.setOffset(filePath, nextOffset, currentSize);

      for (const entry of entries) {
        const key = def.dedupeKey ? def.dedupeKey(entry) : null;

        if (key !== null) {
          if (store.isSeen(filePath, key)) continue;
          store.markSeen(filePath, key);
        }

        await def.persist(entry, filePath);
        processed++;
      }

      // Lifecycle hook: onArchive
      if (def.onArchive && processed > 0) {
        def.onArchive(filePath);
      }
    }

    return processed;
  }

  private _expandGlob(pattern: string): string[] {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return [pattern];
    }
    const dir = dirname(pattern);
    const filePattern = basename(pattern);
    if (!existsSync(dir)) return [];
    const regexStr = filePattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`);
    return readdirSync(dir)
      .filter((f) => regex.test(f))
      .map((f) => join(dir, f));
  }
}
