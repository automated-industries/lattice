import { describe, it, expect } from 'vitest';
import {
  parseSessionMD,
  parseMarkdownEntries,
  generateEntryId,
  validateEntryId,
  DEFAULT_ENTRY_TYPES,
  DEFAULT_TYPE_ALIASES,
} from '../../src/session/entries.js';
import { createReadOnlyHeader, READ_ONLY_HEADER } from '../../src/session/constants.js';

// ---------------------------------------------------------------------------
// parseSessionMD
// ---------------------------------------------------------------------------

describe('parseSessionMD', () => {
  const VALID_ENTRY = `---
id: 2026-03-12T15:30:42Z-agent1-a1b2c3
type: event
timestamp: 2026-03-12T15:30:42Z
project: myproject
tags: [deploy, production]
---
Deployed myproject v2.4.1 to production. Build succeeded in 47s.
===`;

  it('parses a single valid entry', () => {
    const result = parseSessionMD(VALID_ENTRY);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const entry = result.entries[0]!;
    expect(entry.id).toBe('2026-03-12T15:30:42Z-agent1-a1b2c3');
    expect(entry.type).toBe('event');
    expect(entry.timestamp).toBe('2026-03-12T15:30:42Z');
    expect(entry.project).toBe('myproject');
    expect(entry.tags).toEqual(['deploy', 'production']);
    expect(entry.body).toContain('Deployed myproject v2.4.1');
  });

  it('parses multiple entries', () => {
    const content = `---
id: entry-1
type: event
timestamp: 2026-03-12T10:00:00Z
---
First event body.
===
---
id: entry-2
type: learning
timestamp: 2026-03-12T11:00:00Z
---
Second event body.
===`;

    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.type).toBe('event');
    expect(result.entries[1]!.type).toBe('learning');
  });

  it('skips preamble text before first entry', () => {
    const content = `# SESSION — Agent1\n\nWrite entries below.\n\n---
id: entry-1
type: status
timestamp: 2026-03-12T10:00:00Z
---
Status update here.
===`;
    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.body).toBe('Status update here.');
  });

  it('reports error for unclosed header', () => {
    const content = `---
id: entry-1
type: event
timestamp: 2026-03-12T10:00:00Z
`;
    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('never closed');
  });

  it('auto-generates id when missing', () => {
    const content = `---
type: event
timestamp: 2026-03-12T10:00:00Z
---
Body without explicit id.
===`;
    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]!.id).toMatch(/2026-03-12T10:00:00Z-agent-[a-f0-9]{6}/);
  });

  it('normalises type aliases', () => {
    const content = `---
type: task_completion
timestamp: 2026-03-12T10:00:00Z
---
Task done.
===`;
    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]!.type).toBe('event');
  });

  it('parses write entry with op/table/fields', () => {
    const content = `---
type: write
op: update
table: agent
target: agent-123
timestamp: 2026-03-25T10:00:00Z
reason: Promote to senior
---
role: senior engineer
status: active
===`;

    const result = parseSessionMD(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const entry = result.entries[0]!;
    expect(entry.type).toBe('write');
    expect(entry.op).toBe('update');
    expect(entry.table).toBe('agent');
    expect(entry.target).toBe('agent-123');
    expect(entry.reason).toBe('Promote to senior');
    expect(entry.fields).toEqual({ role: 'senior engineer', status: 'active' });
  });

  it('respects startOffset for incremental parsing', () => {
    const firstEntry = `---
id: entry-1
type: event
timestamp: 2026-03-12T10:00:00Z
---
First.
===
`;
    const secondEntry = `---
id: entry-2
type: event
timestamp: 2026-03-12T11:00:00Z
---
Second.
===
`;
    const full = firstEntry + secondEntry;
    const offset = Buffer.byteLength(firstEntry, 'utf-8');
    const result = parseSessionMD(full, offset);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('entry-2');
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownEntries
// ---------------------------------------------------------------------------

describe('parseMarkdownEntries', () => {
  it('parses ## heading entries', () => {
    const content = `## 2026-03-13T22:09Z — task_completion
Completed the daily report generation.

## 2026-03-13T22:52Z — Heartbeat: status check
**type:** status
System running normally.
`;
    const result = parseMarkdownEntries(content, 'agent1');
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.type).toBe('event'); // task_completion alias
    expect(result.entries[1]!.type).toBe('status'); // explicit **type:** override
  });

  it('returns empty for content with no headings', () => {
    const result = parseMarkdownEntries('no headings here', 'agent1');
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateEntryId / validateEntryId
// ---------------------------------------------------------------------------

describe('generateEntryId', () => {
  it('generates deterministic id', () => {
    const id1 = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'body text');
    const id2 = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'body text');
    expect(id1).toBe(id2);
  });

  it('differs for different bodies', () => {
    const id1 = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'body A');
    const id2 = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'body B');
    expect(id1).not.toBe(id2);
  });

  it('has format {timestamp}-{agent}-{6-char-hash}', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'body');
    expect(id).toMatch(/^2026-03-12T10:00:00Z-agent1-[a-f0-9]{6}$/);
  });

  it('lowercases agent name', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'AGENT1', 'body');
    expect(id).toContain('agent1');
  });
});

describe('validateEntryId', () => {
  it('validates a correct id', () => {
    const body = 'some body content';
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent1', body);
    expect(validateEntryId(id, body)).toBe(true);
  });

  it('rejects tampered body', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent1', 'original body');
    expect(validateEntryId(id, 'modified body')).toBe(false);
  });

  it('rejects id with wrong hash length', () => {
    expect(validateEntryId('2026-03-12T10:00:00Z-agent1-ab', 'body')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionParseOptions — custom types and aliases
// ---------------------------------------------------------------------------

describe('parseSessionMD with SessionParseOptions', () => {
  const mkEntry = (type: string) => `---
type: ${type}
timestamp: 2026-03-12T10:00:00Z
---
Body text.
===`;

  it('rejects unknown type with default options', () => {
    const result = parseSessionMD(mkEntry('custom_type'));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('Unknown entry type');
    expect(result.entries).toHaveLength(0);
  });

  it('accepts any type when validTypes is null', () => {
    const result = parseSessionMD(mkEntry('custom_type'), 0, { validTypes: null });
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('custom_type');
  });

  it('uses custom validTypes set', () => {
    const customTypes = new Set(['alert', 'todo']);
    const result = parseSessionMD(mkEntry('alert'), 0, { validTypes: customTypes });
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]!.type).toBe('alert');

    // Built-in type "event" is not in custom set
    const result2 = parseSessionMD(mkEntry('event'), 0, { validTypes: customTypes });
    expect(result2.errors).toHaveLength(1);
  });

  it('uses custom typeAliases', () => {
    const customTypes = new Set(['alert']);
    const customAliases = { warning: 'alert' };
    const result = parseSessionMD(mkEntry('warning'), 0, {
      validTypes: customTypes,
      typeAliases: customAliases,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]!.type).toBe('alert');
  });

  it('disables aliases when typeAliases is null', () => {
    // "task_completion" normally aliases to "event" — not with null aliases
    const result = parseSessionMD(mkEntry('task_completion'), 0, { typeAliases: null });
    expect(result.errors).toHaveLength(1);
  });

  it('applies aliases even when validTypes is null (accept-any mode)', () => {
    const result = parseSessionMD(mkEntry('task_completion'), 0, { validTypes: null });
    expect(result.entries[0]!.type).toBe('event'); // default alias still applies
  });

  it('defaults are backward compatible (no options = same as before)', () => {
    const withDefault = parseSessionMD(mkEntry('event'));
    const withExplicit = parseSessionMD(mkEntry('event'), 0, {
      validTypes: DEFAULT_ENTRY_TYPES as Set<string>,
      typeAliases: { ...DEFAULT_TYPE_ALIASES },
    });
    expect(withDefault.entries).toHaveLength(1);
    expect(withExplicit.entries).toHaveLength(1);
    expect(withDefault.entries[0]!.type).toBe(withExplicit.entries[0]!.type);
  });
});

describe('parseMarkdownEntries with SessionParseOptions', () => {
  it('accepts custom types via options', () => {
    const content = `## 2026-03-13T22:09Z — my_custom_type
Some body text here.
`;
    const result = parseMarkdownEntries(content, 'test', 0, { validTypes: null });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.type).toBe('my_custom_type');
  });
});

// ---------------------------------------------------------------------------
// createReadOnlyHeader
// ---------------------------------------------------------------------------

describe('createReadOnlyHeader', () => {
  it('returns generic text with no args', () => {
    const header = createReadOnlyHeader();
    expect(header).toContain('generated by Lattice');
    expect(header).toContain('the Lattice documentation');
    expect(header).not.toContain('lattice-sync');
    expect(header).not.toContain('agents/shared');
  });

  it('equals the exported READ_ONLY_HEADER constant', () => {
    expect(createReadOnlyHeader()).toBe(READ_ONLY_HEADER);
  });

  it('accepts custom generator and docsRef', () => {
    const header = createReadOnlyHeader({
      generator: 'my-sync-tool',
      docsRef: 'docs/SESSION.md',
    });
    expect(header).toContain('generated by my-sync-tool');
    expect(header).toContain('docs/SESSION.md');
  });
});

// ---------------------------------------------------------------------------
// Exported defaults
// ---------------------------------------------------------------------------

describe('DEFAULT_ENTRY_TYPES / DEFAULT_TYPE_ALIASES', () => {
  it('DEFAULT_ENTRY_TYPES contains expected built-in types', () => {
    expect(DEFAULT_ENTRY_TYPES.has('event')).toBe(true);
    expect(DEFAULT_ENTRY_TYPES.has('write')).toBe(true);
    expect(DEFAULT_ENTRY_TYPES.has('status')).toBe(true);
  });

  it('DEFAULT_TYPE_ALIASES maps known aliases', () => {
    expect(DEFAULT_TYPE_ALIASES.task_completion).toBe('event');
    expect(DEFAULT_TYPE_ALIASES.heartbeat).toBe('status');
  });
});
