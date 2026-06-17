import { describe, it, expect } from 'vitest';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import type { TableDefinition } from '../../src/types.js';

const files = {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT', project_id: 'TEXT' },
  relations: { project: { type: 'belongsTo', table: 'projects', foreignKey: 'project_id' } },
} as unknown as TableDefinition;

const projects = {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
} as unknown as TableDefinition;

describe('deriveCanonicalContexts', () => {
  it('maps table→folder, self ENTITY.md, and bidirectional relation rollups', () => {
    const out = deriveCanonicalContexts([
      { name: 'files', definition: files },
      { name: 'projects', definition: projects },
    ]);
    const byTable = Object.fromEntries(out.map((o) => [o.table, o.definition]));

    expect(byTable.files.directoryRoot).toBe('Files');
    expect(byTable.projects.directoryRoot).toBe('Projects');
    // self + belongsTo rollup on files
    expect(Object.keys(byTable.files.files).sort()).toEqual(['FILE.md', 'PROJECTS.md']);
    // self + reverse hasMany rollup on projects
    expect(Object.keys(byTable.projects.files).sort()).toEqual(['FILES.md', 'PROJECT.md']);
  });

  it('labels an FK-only (junction-style) related row instead of rendering "(row)"', () => {
    const out = deriveCanonicalContexts([
      { name: 'files', definition: files },
      { name: 'projects', definition: projects },
    ]);
    const byTable = Object.fromEntries(out.map((o) => [o.table, o.definition]));
    // The reverse hasMany rollup on projects lists related `files` rows. A row
    // with no name/title/slug/id (e.g. a junction row that is only foreign keys)
    // used to render as the literal placeholder "(row)".
    const render = byTable.projects.files['FILES.md']!.render;
    const md = render([{ project_id: 'p1' } as unknown as Record<string, unknown>]);
    expect(md).not.toContain('(row)');
    expect(md).toContain('project_id: p1'); // first meaningful field surfaced
  });

  it('derives a stable, legible slug preferring name/title/slug', () => {
    const out = deriveCanonicalContexts([{ name: 'files', definition: files }]);
    const slug = out[0]!.definition.slug;
    expect(slug({ id: 'abc', name: 'My File' })).toBe('my-file');
    // falls back to id when no name-like column value present
    expect(slug({ id: 'abc', name: '' })).toBe('abc');
    // an all-punctuation/emoji name slugifies to '' — must fall back, never empty
    const punct = slug({ id: 'abc123', name: '!!!' });
    expect(punct.length).toBeGreaterThan(0);
    expect(punct).toBe('abc123');
  });
});
