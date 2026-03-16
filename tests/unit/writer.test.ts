import { describe, it, expect, afterEach } from 'vitest';
import { atomicWrite } from '../../src/render/writer.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('atomicWrite', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'lattice-test-'));
    dirs.push(d);
    return d;
  }

  it('writes a new file and returns true', () => {
    const dir = tempDir();
    const file = join(dir, 'out.md');
    const written = atomicWrite(file, 'hello');
    expect(written).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });

  it('returns false when content is unchanged', () => {
    const dir = tempDir();
    const file = join(dir, 'out.md');
    atomicWrite(file, 'hello');
    const written = atomicWrite(file, 'hello');
    expect(written).toBe(false);
  });

  it('overwrites and returns true when content changes', () => {
    const dir = tempDir();
    const file = join(dir, 'out.md');
    atomicWrite(file, 'hello');
    const written = atomicWrite(file, 'world');
    expect(written).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('world');
  });

  it('creates nested directories', () => {
    const dir = tempDir();
    const file = join(dir, 'a', 'b', 'out.md');
    const written = atomicWrite(file, 'nested');
    expect(written).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('nested');
  });
});
