import { describe, it, expect } from 'vitest';
import {
  parseSessionMD,
  parseMarkdownEntries,
  generateEntryId,
  validateEntryId,
} from '../../src/session/entries.js';

// ---------------------------------------------------------------------------
// parseSessionMD
// ---------------------------------------------------------------------------

describe('parseSessionMD', () => {
  const VALID_ENTRY = `---
id: 2026-03-12T15:30:42Z-agent-b-a1b2c3
type: event
timestamp: 2026-03-12T15:30:42Z
project: my-project
tags: [deploy, production]
---
Deployed my-project v2.4.1 to production. Build succeeded in 47s.
===`;

  it('parses a single valid entry', () => {
    const result = parseSessionMD(VALID_ENTRY);
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(1);

    const entry = result.entries[0]!;
    expect(entry.id).toBe('2026-03-12T15:30:42Z-agent-b-a1b2c3');
    expect(entry.type).toBe('event');
    expect(entry.timestamp).toBe('2026-03-12T15:30:42Z');
    expect(entry.project).toBe('my-project');
    expect(entry.tags).toEqual(['deploy', 'production']);
    expect(entry.body).toContain('Deployed my-project v2.4.1');
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
    const content = `# SESSION — Cortex\n\nWrite entries below.\n\n---
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
    const result = parseMarkdownEntries(content, 'agent-b');
    expect(result.errors).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.type).toBe('event'); // task_completion alias
    expect(result.entries[1]!.type).toBe('status'); // explicit **type:** override
  });

  it('returns empty for content with no headings', () => {
    const result = parseMarkdownEntries('no headings here', 'agent-b');
    expect(result.entries).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateEntryId / validateEntryId
// ---------------------------------------------------------------------------

describe('generateEntryId', () => {
  it('generates deterministic id', () => {
    const id1 = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'body text');
    const id2 = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'body text');
    expect(id1).toBe(id2);
  });

  it('differs for different bodies', () => {
    const id1 = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'body A');
    const id2 = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'body B');
    expect(id1).not.toBe(id2);
  });

  it('has format {timestamp}-{agent}-{6-char-hash}', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'body');
    expect(id).toMatch(/^2026-03-12T10:00:00Z-agent-b-[a-f0-9]{6}$/);
  });

  it('lowercases agent name', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'CORTEX', 'body');
    expect(id).toContain('agent-b');
  });
});

describe('validateEntryId', () => {
  it('validates a correct id', () => {
    const body = 'some body content';
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', body);
    expect(validateEntryId(id, body)).toBe(true);
  });

  it('rejects tampered body', () => {
    const id = generateEntryId('2026-03-12T10:00:00Z', 'agent-b', 'original body');
    expect(validateEntryId(id, 'modified body')).toBe(false);
  });

  it('rejects id with wrong hash length', () => {
    expect(validateEntryId('2026-03-12T10:00:00Z-agent-b-ab', 'body')).toBe(false);
  });
});
