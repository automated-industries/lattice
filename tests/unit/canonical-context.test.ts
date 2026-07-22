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

  it('emits lattice:// trace links in related rollup files, NOT in self files', () => {
    const out = deriveCanonicalContexts([
      { name: 'files', definition: files },
      { name: 'projects', definition: projects },
    ]);
    const byTable = Object.fromEntries(out.map((o) => [o.table, o.definition]));

    // Self file (FILE.md on files table) must NOT contain links.
    const selfRender = byTable.files.files['FILE.md']!.render;
    const selfMd = selfRender([{ id: 'file-42', name: 'Test File' }]);
    expect(selfMd).not.toMatch(/lattice:\/\//); // no links in self file

    // Related rollup (PROJECTS.md on files table) MUST contain links.
    const relatedRender = byTable.files.files['PROJECTS.md']!.render;
    const relatedMd = relatedRender([{ id: 'proj-99', name: 'My Project' }]);
    expect(relatedMd).toContain('lattice://projects/proj-99'); // link in related file
    expect(relatedMd).toContain('[My Project](lattice://projects/proj-99)'); // markdown link syntax

    // Rows without id should not emit links (plain text fallback).
    const noIdMd = relatedRender([{ name: 'No ID Project' }]);
    expect(noIdMd).not.toContain('lattice://');
    expect(noIdMd).toContain('No ID Project'); // still renders the label

    // Special characters in ID must be URI-encoded.
    const specialIdMd = relatedRender([{ id: 'proj/special:id', name: 'Special' }]);
    expect(specialIdMd).toContain('lattice://projects/proj%2Fspecial%3Aid'); // encoded
  });
});
