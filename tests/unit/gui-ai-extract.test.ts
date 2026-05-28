import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile, describe as describeFile, isCodeFile, languageOf } from '../../src/gui/ai/extract.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-extract-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('extract', () => {
  it('detects code languages', () => {
    expect(languageOf('app.ts')).toBe('typescript');
    expect(languageOf('main.py')).toBe('python');
    expect(isCodeFile('x.rs')).toBe(true);
    expect(isCodeFile('notes.txt')).toBe(false);
  });

  it('reads plain text files', async () => {
    const p = tmpFile('notes.md', '# Title\nbody text');
    const r = await parseFile(p, 'text/markdown', 'notes.md');
    expect(r.text).toContain('body text');
    expect(r.skip).toBeUndefined();
  });

  it('reads code files with a language hint', async () => {
    const p = tmpFile('a.ts', 'export const x = 1;');
    const r = await parseFile(p, 'application/octet-stream', 'a.ts');
    expect(r.text).toContain('export const x');
    expect(r.language).toBe('typescript');
  });

  it('skips binary/unsupported types (no text)', async () => {
    const p = tmpFile('blob.bin', 'whatever');
    const r = await parseFile(p, 'application/octet-stream', 'blob.bin');
    expect(r.skip).toBe(true);
    expect(r.text).toBe('');
  });

  it('describe() summarizes text and falls back for binaries', () => {
    expect(describeFile('  hello   world  ', 'text/plain', 'a.txt')).toBe('hello world');
    expect(describeFile('', 'application/pdf', 'doc.pdf')).toBe('Binary file: doc.pdf (application/pdf)');
    const long = 'x'.repeat(500);
    expect(describeFile(long, 'text/plain', 'a.txt').endsWith('…')).toBe(true);
  });
});
