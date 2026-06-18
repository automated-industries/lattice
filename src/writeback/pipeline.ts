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

      for (const entry of entries) {
        const key = def.dedupeKey ? def.dedupeKey(entry) : null;

        // Skip an entry already persisted (or rejected) in a prior pass.
        if (key !== null && store.isSeen(filePath, key)) continue;

        // Validation gate
        if (def.validate) {
          const result = await def.validate(entry);
          const threshold = def.rejectBelow ?? 0;
          if (!result.pass || result.score < threshold) {
            def.onReject?.(entry, result);
            if (key !== null) store.markSeen(filePath, key); // a rejected entry is consumed
            continue;
          }
        }

        await def.persist(entry, filePath);
        // Mark seen ONLY after a successful persist — so a persist throw leaves the
        // entry un-seen and (with the deferred setOffset below) the batch is re-read
        // on the next sync and the entry re-attempted, never silently dropped. This
        // preserves persist's "called exactly once per unique dedupeKey" contract
        // across a transient failure.
        if (key !== null) store.markSeen(filePath, key);
        processed++;
      }

      // Advance the offset only after the WHOLE batch persisted — a mid-batch throw
      // propagates before this line, so the next sync re-reads from the same offset
      // (dedup skips the entries that already landed).
      store.setOffset(filePath, nextOffset, currentSize);

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
