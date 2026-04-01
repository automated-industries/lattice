import { describe, it, expect } from 'vitest';
import { frontmatter, markdownTable, slugify, truncate } from '../../src/render/markdown.js';

// ---------------------------------------------------------------------------
// frontmatter()
// ---------------------------------------------------------------------------

describe('frontmatter', () => {
  it('generates YAML frontmatter with generated_at', () => {
    const result = frontmatter({ agent: 'Alice' });
    expect(result).toMatch(/^---\ngenerated_at: "\d{4}-\d{2}-\d{2}T/);
    expect(result).toContain('agent: "Alice"');
    expect(result).toMatch(/---\n\n$/);
  });

  it('handles number and boolean values without quotes', () => {
    const result = frontmatter({ count: 5, active: true });
    expect(result).toContain('count: 5');
    expect(result).toContain('active: true');
  });

  it('handles empty fields', () => {
    const result = frontmatter({});
    expect(result).toMatch(/^---\ngenerated_at: "/);
    expect(result).toMatch(/---\n\n$/);
  });
});

// ---------------------------------------------------------------------------
// markdownTable()
// ---------------------------------------------------------------------------

describe('markdownTable', () => {
  const rows = [
    { name: 'Alice', role: 'engineer', status: 'active' },
    { name: 'Bob', role: 'designer', status: 'inactive' },
  ];

  it('generates a GFM table with headers and rows', () => {
    const result = markdownTable(rows, [
      { key: 'name', header: 'Name' },
      { key: 'role', header: 'Role' },
    ]);
    expect(result).toContain('| Name | Role |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| Alice | engineer |');
    expect(result).toContain('| Bob | designer |');
  });

  it('applies format functions per column', () => {
    const result = markdownTable(rows, [
      { key: 'name', header: 'Name', format: (v) => `**${String(v)}**` },
      { key: 'status', header: 'Status', format: (v) => String(v).toUpperCase() },
    ]);
    expect(result).toContain('| **Alice** | ACTIVE |');
    expect(result).toContain('| **Bob** | INACTIVE |');
  });

  it('format callback receives full row', () => {
    const result = markdownTable(rows, [
      {
        key: 'name',
        header: 'Link',
        format: (_, row) => `[${String(row.name)}](${String(row.name).toLowerCase()}/DETAIL.md)`,
      },
    ]);
    expect(result).toContain('| [Alice](alice/DETAIL.md) |');
  });

  it('returns empty string for empty rows', () => {
    expect(markdownTable([], [{ key: 'name', header: 'Name' }])).toBe('');
  });

  it('returns empty string for empty columns', () => {
    expect(markdownTable(rows, [])).toBe('');
  });

  it('handles null/undefined values as empty string', () => {
    const rowsWithNull = [{ name: 'Alice', role: null }];
    const result = markdownTable(rowsWithNull, [
      { key: 'name', header: 'Name' },
      { key: 'role', header: 'Role' },
    ]);
    expect(result).toContain('| Alice |  |');
  });
});

// ---------------------------------------------------------------------------
// slugify()
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My Agent Name')).toBe('my-agent-name');
  });

  it('strips diacritics', () => {
    expect(slugify('José García')).toBe('jose-garcia');
  });

  it('handles Turkish dotless i', () => {
    expect(slugify('İstanbul')).toBe('istanbul');
  });

  it('replaces non-alphanumeric runs with single hyphen', () => {
    expect(slugify('hello...world!!!')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles single word', () => {
    expect(slugify('Alice')).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// truncate()
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns content unchanged when within budget', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('truncates content exceeding budget with default notice', () => {
    const result = truncate('a'.repeat(200), 100);
    expect(result.length).toBeGreaterThan(100);
    expect(result).toContain('*[truncated — context budget exceeded]*');
    expect(result.startsWith('a'.repeat(100))).toBe(true);
  });

  it('uses custom notice when provided', () => {
    const result = truncate('a'.repeat(200), 100, ' [cut]');
    expect(result).toBe('a'.repeat(100) + ' [cut]');
  });

  it('handles exact budget boundary', () => {
    const content = 'a'.repeat(100);
    expect(truncate(content, 100)).toBe(content);
  });
});
