import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileJunctions } from '../../src/gui/data.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeConfig(body: string): { configPath: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-fj-'));
  dirs.push(root);
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, body);
  return { configPath, outputDir: join(root, 'context') };
}

describe('fileJunctions', () => {
  it('resolves a junction connecting files to another entity, with FK columns', () => {
    const { configPath, outputDir } = writeConfig(
      [
        'db: ./data/test.db',
        'entities:',
        '  projects:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: projects.md',
        '  project_files:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      project_id: { type: uuid, ref: projects }',
        '      file_id: { type: uuid, ref: files }',
        '    outputFile: project-files.md',
        '',
      ].join('\n'),
    );
    const result = fileJunctions(configPath, outputDir);
    expect(result).toEqual([
      { junction: 'project_files', fileFk: 'file_id', otherTable: 'projects', otherFk: 'project_id' },
    ]);
  });

  it('returns [] when no junction touches files', () => {
    const { configPath, outputDir } = writeConfig(
      [
        'db: ./data/test.db',
        'entities:',
        '  people:',
        '    fields:',
        '      id: { type: uuid, primaryKey: true }',
        '      name: { type: text }',
        '    outputFile: people.md',
        '',
      ].join('\n'),
    );
    expect(fileJunctions(configPath, outputDir)).toEqual([]);
  });
});
