import {
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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

      // Resolve the parsed batch and the ABSOLUTE next byte offset to store once
      // the whole batch has persisted. Two paths:
      //  - default: read the whole file, parse from the absolute offset, store
      //    the parser's nextOffset verbatim — byte-for-byte the original behavior.
      //  - incremental (opt-in): read only the new tail, parse a slice from 0,
      //    and translate the slice-relative nextOffset back to an absolute byte
      //    offset before storing.
      let entries: unknown[];
      let nextAbsoluteOffset: number;

      if (def.incrementalRead) {
        const len = currentSize - offset;
        const buf = Buffer.allocUnsafe(len);
        const fd = openSync(filePath, 'r');
        let bytesRead: number;
        try {
          bytesRead = readSync(fd, buf, 0, len, offset);
        } finally {
          closeSync(fd);
        }
        // Decode incrementally so a multi-byte codepoint straddling the trailing
        // edge is not split into a replacement char: StringDecoder holds back the
        // incomplete trailing bytes and emits only complete codepoints. Those
        // held-back bytes are simply not consumed this tick — they arrive on the
        // next tick once the rest is written, because the absolute offset only
        // advances past the bytes actually consumed below.
        const decoder = new StringDecoder('utf8');
        const slice = decoder.write(buf.subarray(0, bytesRead));
        const result = def.parse(slice, 0);
        entries = result.entries;
        // The parser's nextOffset is a string index into the slice. Map it back
        // to bytes (the consumed prefix's UTF-8 byte length) and add the prior
        // byte offset so the stored offset is always absolute. Any unconsumed
        // tail (a partial trailing line, or codepoint bytes held back by the
        // decoder) stays un-advanced and is re-read next tick.
        const consumedBytes = Buffer.byteLength(slice.slice(0, result.nextOffset), 'utf8');
        nextAbsoluteOffset = offset + consumedBytes;
      } else {
        const content = readFileSync(filePath, 'utf8');
        const parsed = def.parse(content, offset);
        entries = parsed.entries;
        nextAbsoluteOffset = parsed.nextOffset;
      }

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
      // (dedup skips the entries that already landed). The offset is absolute in
      // both modes: the parser's verbatim nextOffset in the default path, the
      // slice-relative offset translated back to bytes in the incremental path.
      store.setOffset(filePath, nextAbsoluteOffset, currentSize);

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
