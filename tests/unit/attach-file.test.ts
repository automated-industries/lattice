import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

describe('attachFileColumn', () => {
  let db: Lattice;
  let tmpDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lattice-attach-'));
    outputDir = join(tmpDir, 'output');
    const dbPath = join(tmpDir, 'test.db');

    db = new Lattice(dbPath);

    db.define('documents', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        name: 'TEXT NOT NULL',
        file_path: 'TEXT',
        created_at: 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: '.schema-only/documents.md',
    });

    db.defineEntityContext('documents', {
      slug: (r) => r.name as string,
      directoryRoot: 'docs',
      attachFileColumn: 'file_path',
      files: {
        'DOC.md': {
          source: { type: 'self' },
          render: ([r]) => `# ${r.name as string}\nPath: ${(r.file_path as string) ?? 'none'}`,
        },
      },
    });

    await db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies referenced file into entity directory during render', async () => {
    // Create a source file
    const srcFile = join(tmpDir, 'report.pdf');
    writeFileSync(srcFile, 'fake pdf content');

    await db.insert('documents', {
      name: 'quarterly-report',
      file_path: srcFile,
    });

    await db.render(outputDir);

    // Check that the file was copied into the entity dir
    const entityDir = join(outputDir, 'docs', 'quarterly-report');
    expect(existsSync(join(entityDir, 'DOC.md'))).toBe(true);
    expect(existsSync(join(entityDir, 'report.pdf'))).toBe(true);
    expect(readFileSync(join(entityDir, 'report.pdf'), 'utf8')).toBe('fake pdf content');
  });

  it('skips copy when file does not exist', async () => {
    await db.insert('documents', {
      name: 'missing-doc',
      file_path: '/nonexistent/file.pdf',
    });

    await db.render(outputDir);

    const entityDir = join(outputDir, 'docs', 'missing-doc');
    expect(existsSync(join(entityDir, 'DOC.md'))).toBe(true);
    expect(existsSync(join(entityDir, 'file.pdf'))).toBe(false);
  });

  it('skips copy when file_path is null', async () => {
    await db.insert('documents', {
      name: 'no-path',
      file_path: null,
    });

    await db.render(outputDir);

    const entityDir = join(outputDir, 'docs', 'no-path');
    expect(existsSync(join(entityDir, 'DOC.md'))).toBe(true);
  });

  it('resolves relative paths from outputDir', async () => {
    // Create source file relative to output dir
    const srcFile = join(outputDir, 'uploads', 'data.csv');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(outputDir, 'uploads'), { recursive: true });
    writeFileSync(srcFile, 'col1,col2');

    await db.insert('documents', {
      name: 'data-file',
      file_path: 'uploads/data.csv',
    });

    await db.render(outputDir);

    const entityDir = join(outputDir, 'docs', 'data-file');
    expect(existsSync(join(entityDir, 'data.csv'))).toBe(true);
  });
});
