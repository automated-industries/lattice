import { describe, it, expect, vi, afterEach } from 'vitest';
import { WritebackPipeline } from '../../src/writeback/pipeline.js';
import { writeFileSync, mkdtempSync, rmSync, writeSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-wb-'));
  dirs.push(d);
  return d;
}

/** Simple line-by-line parser — splits new content into non-empty lines */
function lineParser(content: string, fromOffset: number) {
  const newContent = content.slice(fromOffset);
  const entries = newContent.split('\n').filter((l) => l.trim().length > 0);
  return { entries, nextOffset: fromOffset + newContent.length };
}

describe('WritebackPipeline', () => {
  it('calls persist for each parsed entry', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'entry1\nentry2\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: lineParser, persist });

    const count = await pipeline.process();
    expect(count).toBe(2);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith('entry1', file);
    expect(persist).toHaveBeenCalledWith('entry2', file);
  });

  it('tracks byte offset and only processes new content', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'entry1\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: lineParser, persist });

    await pipeline.process(); // processes entry1

    // Append entry2
    const fd = openSync(file, 'a');
    writeSync(fd, 'entry2\n');
    closeSync(fd);

    await pipeline.process(); // should only process entry2
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(1, 'entry1', file);
    expect(persist).toHaveBeenNthCalledWith(2, 'entry2', file);
  });

  it('deduplicates entries by dedupeKey', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'id-1\nid-1\nid-2\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({
      file,
      parse: lineParser,
      persist,
      dedupeKey: (entry) => entry as string,
    });

    await pipeline.process();
    // id-1 appears twice but should only be persisted once
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith('id-1', file);
    expect(persist).toHaveBeenCalledWith('id-2', file);
  });

  it('resets offset on file truncation', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'entry1\nentry2\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: lineParser, persist });

    await pipeline.process(); // processes both entries, offset = file size

    // Truncate and write new smaller content
    writeFileSync(file, 'new1\n');

    await pipeline.process(); // offset > size → reset → process new1
    expect(persist).toHaveBeenCalledTimes(3); // entry1, entry2, new1
  });

  it('skips non-existent files gracefully', async () => {
    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({
      file: '/nonexistent/path/session.md',
      parse: lineParser,
      persist,
    });

    const count = await pipeline.process();
    expect(count).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it('expands glob patterns', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a-session.md'), 'from-a\n');
    writeFileSync(join(dir, 'b-session.md'), 'from-b\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({
      file: join(dir, '*-session.md'),
      parse: lineParser,
      persist,
    });

    const count = await pipeline.process();
    expect(count).toBe(2);
  });

  it('does not lose or duplicate entries when persist throws mid-batch', async () => {
    // Regression: the offset advanced (and entries were marked seen) BEFORE persist,
    // so a mid-batch persist throw left the offset past the un-persisted tail and the
    // failing entry marked seen — silently dropping it on the next sync. The fix marks
    // an entry seen only AFTER a successful persist and advances the offset only after
    // the whole batch succeeds, so a failed batch is re-read (dedup skips the entries
    // that already landed) until every entry persists. persist's contract is "called
    // exactly once per unique dedupeKey" — that must survive a transient failure.
    const dir = tempDir();
    const file = join(dir, 'log.md');
    writeFileSync(file, 'entry1\nentry2\n');

    const pipeline = new WritebackPipeline();
    const persisted: string[] = [];
    let failOnEntry2 = true;
    const persist = vi.fn((entry: unknown): Promise<void> => {
      if (entry === 'entry2' && failOnEntry2) {
        return Promise.reject(new Error('persist failed (transient)'));
      }
      persisted.push(entry as string);
      return Promise.resolve();
    });
    pipeline.define({ file, parse: lineParser, persist, dedupeKey: (e) => e as string });

    // First sync: entry1 persists, entry2 throws → the batch fails LOUDLY (a
    // partial-batch failure surfaces; it is never swallowed into a silent success).
    await expect(pipeline.process()).rejects.toThrow('persist failed');
    expect(persisted).toEqual(['entry1']); // entry1 done; entry2 not

    // Recover: persist now succeeds. The offset must not have advanced past entry2 and
    // entry2 must not have been marked seen, so the retry re-reads the batch, skips the
    // already-persisted entry1 (dedup), and finally lands entry2 — no loss, no dup.
    failOnEntry2 = false;
    const count = await pipeline.process();
    expect(persisted).toEqual(['entry1', 'entry2']); // entry2 recovered; entry1 NOT duplicated
    expect(count).toBe(1); // only entry2 processed on the retry
  });
});

describe('WritebackPipeline — opt-in incremental read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Incremental-mode parser: operates PURELY on the byte-slice it receives.
   * `fromOffset` is always 0 (the pipeline passes only the new tail), so
   * `nextOffset` is relative to the slice (== slice length once fully consumed).
   * This is the hard precondition incremental mode documents.
   */
  function sliceLineParser(content: string, fromOffset: number) {
    // fromOffset is 0 in incremental mode; honored anyway for symmetry.
    const slice = content.slice(fromOffset);
    const entries = slice.split('\n').filter((l) => l.trim().length > 0);
    return { entries, nextOffset: fromOffset + slice.length };
  }

  it('reads only currentSize - offset bytes on the second tick', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'entry1\n'); // 7 bytes

    // Record the byte length of every slice the pipeline hands the parser. In
    // incremental mode the slice == the bytes actually read off disk, so the
    // second tick's slice length proves only `currentSize - offset` was read.
    const sliceByteLengths: number[] = [];
    const measuringParser = (content: string, fromOffset: number) => {
      sliceByteLengths.push(Buffer.byteLength(content, 'utf8'));
      const slice = content.slice(fromOffset);
      return {
        entries: slice.split('\n').filter((l) => l.trim().length > 0),
        nextOffset: fromOffset + slice.length,
      };
    };

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: measuringParser, persist, incrementalRead: true });

    await pipeline.process(); // consumes entry1; offset advances to 7

    // Append entry2 (7 more bytes) → file is now 14 bytes.
    const fd = openSync(file, 'a');
    writeSync(fd, 'entry2\n');
    closeSync(fd);

    await pipeline.process(); // should read ONLY the 7-byte tail, from offset 7

    expect(sliceByteLengths).toEqual([7, 7]); // tick1: full file; tick2: only the new tail
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(1, 'entry1', file);
    expect(persist).toHaveBeenNthCalledWith(2, 'entry2', file);
  });

  it('passes only the new tail to the parser with fromOffset 0', async () => {
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'alpha\n');

    const seenContents: string[] = [];
    const seenOffsets: number[] = [];
    const recordingParser = (content: string, fromOffset: number) => {
      seenContents.push(content);
      seenOffsets.push(fromOffset);
      const slice = content.slice(fromOffset);
      return {
        entries: slice.split('\n').filter((l) => l.trim().length > 0),
        nextOffset: fromOffset + slice.length,
      };
    };

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: recordingParser, persist, incrementalRead: true });

    await pipeline.process(); // first tick: whole file is "new"

    const fd = openSync(file, 'a');
    writeSync(fd, 'beta\n');
    closeSync(fd);

    await pipeline.process(); // second tick: only "beta\n" is new

    expect(seenOffsets).toEqual([0, 0]); // fromOffset is ALWAYS 0 in incremental mode
    expect(seenContents[0]).toBe('alpha\n'); // first slice: whole file
    expect(seenContents[1]).toBe('beta\n'); // second slice: ONLY the new tail
  });

  it('produces the SAME persisted entries as the default whole-file path', async () => {
    const appendBetweenTicks = 'cccc\ndddd\n';
    const initial = 'aaaa\nbbbb\n';

    async function run(incremental: boolean): Promise<string[]> {
      const dir = tempDir();
      const file = join(dir, 'session.md');
      writeFileSync(file, initial);

      const got: string[] = [];
      const pipeline = new WritebackPipeline();
      const persist = vi.fn((entry: unknown): Promise<void> => {
        got.push(entry as string);
        return Promise.resolve();
      });
      pipeline.define({
        file,
        parse: incremental ? sliceLineParser : lineParser,
        persist,
        dedupeKey: (e) => e as string,
        incrementalRead: incremental,
      });

      await pipeline.process(); // tick 1

      const fd = openSync(file, 'a');
      writeSync(fd, appendBetweenTicks);
      closeSync(fd);

      await pipeline.process(); // tick 2 (across the append)
      return got;
    }

    const def = await run(false);
    const inc = await run(true);
    expect(inc).toEqual(def);
    expect(inc).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd']);
  });

  it('does not split a multi-byte UTF-8 char across the slice boundary', async () => {
    // Each emoji "😀" is 4 UTF-8 bytes. Two of them with a trailing newline.
    const dir = tempDir();
    const file = join(dir, 'session.md');
    const text = '😀😀\n';
    writeFileSync(file, text, 'utf8');

    const seen: string[] = [];
    const decodeParser = (content: string, fromOffset: number) => {
      const slice = content.slice(fromOffset);
      // The pipeline must hand us a cleanly-decoded string — no replacement char.
      expect(slice.includes('�')).toBe(false);
      const entries = slice.split('\n').filter((l) => l.trim().length > 0);
      for (const e of entries) seen.push(e);
      return { entries, nextOffset: fromOffset + slice.length };
    };

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: decodeParser, persist, incrementalRead: true });

    await pipeline.process();
    expect(seen).toEqual(['😀😀']);
  });

  it('preserves the mid-batch-throw ordering invariant in incremental mode', async () => {
    // Same invariant as the default-path regression: a persist throw mid-batch must
    // leave the (absolute) offset un-advanced and the failing entry un-seen, so the
    // batch is re-read and the entry re-attempted — never silently dropped.
    const dir = tempDir();
    const file = join(dir, 'log.md');
    writeFileSync(file, 'entry1\nentry2\n');

    const pipeline = new WritebackPipeline();
    const persisted: string[] = [];
    let failOnEntry2 = true;
    const persist = vi.fn((entry: unknown): Promise<void> => {
      if (entry === 'entry2' && failOnEntry2) {
        return Promise.reject(new Error('persist failed (transient)'));
      }
      persisted.push(entry as string);
      return Promise.resolve();
    });
    pipeline.define({
      file,
      parse: sliceLineParser,
      persist,
      dedupeKey: (e) => e as string,
      incrementalRead: true,
    });

    await expect(pipeline.process()).rejects.toThrow('persist failed');
    expect(persisted).toEqual(['entry1']);

    failOnEntry2 = false;
    const count = await pipeline.process();
    expect(persisted).toEqual(['entry1', 'entry2']); // recovered, not dropped, not duplicated
    expect(count).toBe(1);
  });

  it('advances the absolute offset across an append in incremental mode', async () => {
    // Guards the absolute-offset bookkeeping: after the second tick the stored offset
    // must equal the full file size, so a third tick with no new bytes is a no-op.
    const dir = tempDir();
    const file = join(dir, 'session.md');
    writeFileSync(file, 'one\n');

    const pipeline = new WritebackPipeline();
    const persist = vi.fn().mockResolvedValue(undefined);
    pipeline.define({ file, parse: sliceLineParser, persist, incrementalRead: true });

    await pipeline.process(); // one
    const fd = openSync(file, 'a');
    writeSync(fd, 'two\n');
    closeSync(fd);
    await pipeline.process(); // two

    // Third tick: no new content → no additional persist.
    await pipeline.process();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(1, 'one', file);
    expect(persist).toHaveBeenNthCalledWith(2, 'two', file);
  });
});
