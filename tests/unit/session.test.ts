import { describe, it, expect } from 'vitest';
import { parseSessionWrites, generateWriteEntryId } from '../../src/session/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Record<string, string> = {}, body = ''): string {
  const header: Record<string, string> = {
    type: 'write',
    timestamp: '2026-03-25T10:30:00Z',
    op: 'update',
    table: 'agent',
    target: 'agent1',
    ...overrides,
  };
  const headerLines = Object.entries(header)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${headerLines}\n---\n${body}\n===\n`;
}

// ---------------------------------------------------------------------------
// parseSessionWrites — valid entries
// ---------------------------------------------------------------------------

describe('parseSessionWrites — valid update entry', () => {
  it('parses op/table/target/fields correctly', () => {
    const content = makeEntry({}, 'status: active\ntags: deploy, production');
    const result = parseSessionWrites(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.op).toBe('update');
    expect(entry.table).toBe('agent');
    expect(entry.target).toBe('agent1');
    expect(entry.fields).toEqual({ status: 'active', tags: 'deploy, production' });
    expect(entry.timestamp).toBe('2026-03-25T10:30:00Z');
  });
});

describe('parseSessionWrites — valid create entry (no target)', () => {
  it('target is undefined when not provided', () => {
    const content = makeEntry({ op: 'create', target: '' }, 'name: hal');
    const result = parseSessionWrites(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.op).toBe('create');
    expect(entry.target).toBeUndefined();
    expect(entry.fields).toEqual({ name: 'hal' });
  });
});

describe('parseSessionWrites — valid delete entry', () => {
  it('fields is empty for delete', () => {
    const content = makeEntry({ op: 'delete' }, 'status: ignored');
    const result = parseSessionWrites(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.op).toBe('delete');
    expect(entry.fields).toEqual({});
  });
});

describe('parseSessionWrites — skips non-write entries', () => {
  it('returns empty entries array for event-type entries', () => {
    const content = `---\ntype: event\ntimestamp: 2026-03-25T10:00:00Z\nevent: task_completed\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('parseSessionWrites — mixed content', () => {
  it('returns only write entries when mixed with event entries', () => {
    const eventEntry = `---\ntype: event\ntimestamp: 2026-03-25T09:00:00Z\nevent: started\n---\n\n===\n`;
    const writeEntry = makeEntry({}, 'status: active');
    const content = eventEntry + writeEntry;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.op).toBe('update');
  });
});

// ---------------------------------------------------------------------------
// parseSessionWrites — validation errors
// ---------------------------------------------------------------------------

describe('parseSessionWrites — missing op', () => {
  it('returns a parse error', () => {
    const content = `---\ntype: write\ntimestamp: 2026-03-25T10:30:00Z\ntable: agent\ntarget: agent1\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/Missing required field: op/);
  });
});

describe('parseSessionWrites — missing table', () => {
  it('returns a parse error', () => {
    const content = `---\ntype: write\ntimestamp: 2026-03-25T10:30:00Z\nop: update\ntarget: agent1\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/Missing required field: table/);
  });
});

describe('parseSessionWrites — missing timestamp', () => {
  it('returns a parse error', () => {
    const content = `---\ntype: write\nop: update\ntable: agent\ntarget: agent1\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/Missing required field: timestamp/);
  });
});

describe('parseSessionWrites — update missing target', () => {
  it('returns a parse error', () => {
    const content = `---\ntype: write\ntimestamp: 2026-03-25T10:30:00Z\nop: update\ntable: agent\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/target.*required.*update/i);
  });
});

describe('parseSessionWrites — delete missing target', () => {
  it('returns a parse error', () => {
    const content = `---\ntype: write\ntimestamp: 2026-03-25T10:30:00Z\nop: delete\ntable: agent\n---\n\n===\n`;
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/target.*required.*delete/i);
  });
});

describe('parseSessionWrites — invalid table name (spaces/special chars)', () => {
  it('returns a parse error', () => {
    const content = makeEntry({ table: 'my table!' });
    const result = parseSessionWrites(content);
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/Invalid table name/);
  });
});

describe('parseSessionWrites — invalid field name', () => {
  it('skips invalid field names rather than erroring', () => {
    const content = makeEntry({}, 'valid_field: ok\ninvalid field!: bad\nanother: fine');
    const result = parseSessionWrites(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    const fields = result.entries[0]!.fields;
    expect(fields.valid_field).toBe('ok');
    expect(fields.another).toBe('fine');
    // invalid field should not appear
    expect(Object.keys(fields)).not.toContain('invalid field!');
  });
});

describe('parseSessionWrites — multiple write entries', () => {
  it('parses all entries correctly', () => {
    const entry1 = makeEntry({ target: 'agent1' }, 'status: active');
    const entry2 = makeEntry(
      { target: 'hal', table: 'agent', timestamp: '2026-03-25T11:00:00Z' },
      'status: idle',
    );
    const result = parseSessionWrites(entry1 + entry2);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.target).toBe('agent1');
    expect(result.entries[1]!.target).toBe('hal');
  });
});

describe('parseSessionWrites — empty file', () => {
  it('returns 0 entries and 0 errors', () => {
    const result = parseSessionWrites('');
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('parseSessionWrites — body with multi-word values', () => {
  it('parses "status: in progress" correctly', () => {
    const content = makeEntry({}, 'status: in progress');
    const result = parseSessionWrites(content);
    expect(result.errors).toHaveLength(0);
    expect(result.entries[0]!.fields.status).toBe('in progress');
  });
});

// ---------------------------------------------------------------------------
// generateWriteEntryId
// ---------------------------------------------------------------------------

describe('generateWriteEntryId — deterministic', () => {
  it('produces the same ID for the same inputs', () => {
    const id1 = generateWriteEntryId('2026-03-25T10:30:00Z', 'agent1', 'update', 'agent', 'hal');
    const id2 = generateWriteEntryId('2026-03-25T10:30:00Z', 'agent1', 'update', 'agent', 'hal');
    expect(id1).toBe(id2);
  });
});

describe('generateWriteEntryId — different inputs produce different IDs', () => {
  it('produces different IDs when inputs differ', () => {
    const id1 = generateWriteEntryId('2026-03-25T10:30:00Z', 'agent1', 'update', 'agent', 'hal');
    const id2 = generateWriteEntryId('2026-03-25T10:30:00Z', 'agent1', 'create', 'agent', 'hal');
    expect(id1).not.toBe(id2);

    const id3 = generateWriteEntryId('2026-03-25T10:30:00Z', 'agent1', 'update', 'agent', 'agent1');
    expect(id1).not.toBe(id3);
  });
});
