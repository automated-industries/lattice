import { describe, it, expect } from 'vitest';
import { compileEntityRender } from '../../src/render/entity-templates.js';
import type { Row } from '../../src/types.js';

describe('entity-table template', () => {
  it('renders heading + GFM table', () => {
    const render = compileEntityRender({
      template: 'entity-table',
      heading: 'Skills',
      columns: [
        { key: 'name', header: 'Name' },
        { key: 'level', header: 'Level', format: (v) => String(v || '—') },
      ],
    });

    const md = render([
      { name: 'TypeScript', level: 'expert' },
      { name: 'Python', level: null },
    ]);

    expect(md).toContain('# Skills');
    expect(md).toContain('| Name | Level |');
    expect(md).toContain('| TypeScript | expert |');
    expect(md).toContain('| Python | — |');
    expect(md).toContain('generated_at:');
  });

  it('renders empty message for zero rows', () => {
    const render = compileEntityRender({
      template: 'entity-table',
      heading: 'Items',
      columns: [{ key: 'name', header: 'Name' }],
      emptyMessage: '*Nothing here.*',
    });

    expect(render([])).toContain('*Nothing here.*');
  });

  it('applies beforeRender filter', () => {
    const render = compileEntityRender({
      template: 'entity-table',
      heading: 'Active',
      columns: [{ key: 'name', header: 'Name' }],
      beforeRender: (rows) => rows.filter(r => r.status === 'active'),
    });

    const md = render([
      { name: 'Alice', status: 'active' },
      { name: 'Bob', status: 'inactive' },
    ]);

    expect(md).toContain('Alice');
    expect(md).not.toContain('Bob');
  });
});

describe('entity-profile template', () => {
  it('renders heading + fields + enriched sections', () => {
    const render = compileEntityRender({
      template: 'entity-profile',
      heading: (r) => r.name as string,
      fields: [
        { key: 'status', label: 'Status' },
        { key: 'role', label: 'Role' },
      ],
      sections: [
        { key: 'skills', heading: 'Skills', render: 'list', formatItem: (item) => `${item.name} (${item.level})` },
      ],
    });

    const md = render([{
      name: 'Alice',
      status: 'active',
      role: 'engineer',
      _skills: JSON.stringify([
        { name: 'TypeScript', level: 'expert' },
        { name: 'Go', level: 'intermediate' },
      ]),
    }]);

    expect(md).toContain('# Alice');
    expect(md).toContain('**Status:** active');
    expect(md).toContain('**Role:** engineer');
    expect(md).toContain('## Skills');
    expect(md).toContain('- TypeScript (expert)');
    expect(md).toContain('- Go (intermediate)');
  });

  it('skips null fields', () => {
    const render = compileEntityRender({
      template: 'entity-profile',
      heading: 'Test',
      fields: [{ key: 'missing', label: 'Missing' }],
    });

    expect(render([{ missing: null }])).not.toContain('**Missing:**');
  });
});

describe('entity-sections template', () => {
  it('renders per-row sections with metadata and body', () => {
    const render = compileEntityRender({
      template: 'entity-sections',
      heading: 'Rules',
      perRow: {
        heading: (r) => r.title as string,
        metadata: [
          { key: 'scope', label: 'Scope' },
          { key: 'priority', label: 'Priority', format: (v) => `P${v}` },
        ],
        body: (r) => r.text as string,
      },
    });

    const md = render([
      { title: 'Rule A', scope: 'org', priority: 1, text: 'Do X.' },
      { title: 'Rule B', scope: 'agent', priority: 2, text: 'Do Y.' },
    ]);

    expect(md).toContain('# Rules');
    expect(md).toContain('## Rule A');
    expect(md).toContain('**Scope:** org | **Priority:** P1');
    expect(md).toContain('Do X.');
    expect(md).toContain('## Rule B');
  });

  it('renders empty message', () => {
    const render = compileEntityRender({
      template: 'entity-sections',
      heading: 'Items',
      perRow: { heading: (r) => r.name as string },
      emptyMessage: '*None defined.*',
    });

    expect(render([])).toContain('*None defined.*');
  });
});

describe('function passthrough', () => {
  it('returns function unchanged', () => {
    const fn = (rows: Row[]) => `count: ${rows.length}`;
    expect(compileEntityRender(fn)).toBe(fn);
  });
});
