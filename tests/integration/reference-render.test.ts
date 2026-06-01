import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("attachFileMode: 'reference'", () => {
  it('writes a .ref.md pointer and does not copy bytes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-refr-'));
    dirs.push(base);
    const db = new Lattice(join(base, 'db.sqlite'));
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', loc: 'TEXT' },
      render: () => '',
      outputFile: '.schema-only/docs.md',
    });
    db.defineEntityContext('docs', {
      slug: (r) => String(r.name),
      attachFileColumn: 'loc',
      attachFileMode: 'reference',
      files: { 'DOC.md': { source: { type: 'self' }, render: ([r]) => `# ${String(r?.name)}` } },
    });
    await db.init();
    await db.insert('docs', { name: 'spec', loc: 'https://example.com/spec.pdf' });

    const out = join(base, 'ctx');
    await db.render(out);

    const refFile = join(out, 'docs', 'spec', 'spec.pdf.ref.md');
    expect(existsSync(refFile)).toBe(true);
    expect(readFileSync(refFile, 'utf-8')).toContain('https://example.com/spec.pdf');
    // the URL/file is indexed in place — never copied
    expect(existsSync(join(out, 'docs', 'spec', 'spec.pdf'))).toBe(false);
    db.close();
  });
});
