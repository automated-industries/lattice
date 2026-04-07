import { describe, it, expect } from 'vitest';
import { WritebackPipeline } from '../../src/writeback/pipeline.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Writeback validation', () => {
  let dir: string;

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'wb-val-'));
  }

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  it('rejects entries that fail validation', async () => {
    setup();
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'line1\nline2\nline3\n');

    const persisted: unknown[] = [];
    const rejected: unknown[] = [];

    const pipeline = new WritebackPipeline();
    pipeline.define({
      file,
      parse: (content) => ({
        entries: content.trim().split('\n'),
        nextOffset: content.length,
      }),
      persist: (entry) => {
        persisted.push(entry);
      },
      validate: (entry) => {
        const line = entry as string;
        return line === 'line2'
          ? { pass: false, score: 0.1, reason: 'bad line' }
          : { pass: true, score: 0.9 };
      },
      onReject: (entry, result) => {
        rejected.push({ entry, result });
      },
    });

    const count = await pipeline.process();
    expect(count).toBe(2); // line1 and line3 persisted
    expect(persisted).toEqual(['line1', 'line3']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      entry: 'line2',
      result: { pass: false, score: 0.1, reason: 'bad line' },
    });

    cleanup();
  });

  it('rejects entries below rejectBelow threshold even if pass is true', async () => {
    setup();
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'good\nweak\n');

    const persisted: unknown[] = [];

    const pipeline = new WritebackPipeline();
    pipeline.define({
      file,
      parse: (content) => ({
        entries: content.trim().split('\n'),
        nextOffset: content.length,
      }),
      persist: (entry) => {
        persisted.push(entry);
      },
      validate: (entry) => ({
        pass: true,
        score: (entry as string) === 'good' ? 0.9 : 0.3,
      }),
      rejectBelow: 0.5,
    });

    const count = await pipeline.process();
    expect(count).toBe(1);
    expect(persisted).toEqual(['good']);

    cleanup();
  });

  it('persists all entries when no validate hook is set', async () => {
    setup();
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'a\nb\n');

    const persisted: unknown[] = [];

    const pipeline = new WritebackPipeline();
    pipeline.define({
      file,
      parse: (content) => ({
        entries: content.trim().split('\n'),
        nextOffset: content.length,
      }),
      persist: (entry) => {
        persisted.push(entry);
      },
    });

    const count = await pipeline.process();
    expect(count).toBe(2);
    expect(persisted).toEqual(['a', 'b']);

    cleanup();
  });

  it('supports async validate', async () => {
    setup();
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'ok\n');

    const persisted: unknown[] = [];

    const pipeline = new WritebackPipeline();
    pipeline.define({
      file,
      parse: (content) => ({
        entries: content.trim().split('\n'),
        nextOffset: content.length,
      }),
      persist: (entry) => {
        persisted.push(entry);
      },
      validate: () => {
        return { pass: true, score: 1.0 };
      },
    });

    const count = await pipeline.process();
    expect(count).toBe(1);
    expect(persisted).toEqual(['ok']);

    cleanup();
  });
});
