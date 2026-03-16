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
});
