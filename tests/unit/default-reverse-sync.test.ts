import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  diffToUpdates,
  deriveUpdatesFromFile,
} from '../../src/reverse-sync/default-reverse-sync.js';
import type { Row } from '../../src/types.js';

describe('parseFrontmatter', () => {
  it('parses frontmatter fields and drops the render-injected generated_at', () => {
    const content =
      '---\ngenerated_at: "2026-01-01T00:00:00Z"\nrole: Scout\ncount: 5\nactive: true\n---\n\n# Body\n';
    const r = parseFrontmatter(content);
    expect(r).not.toBeNull();
    expect(r?.fields).toEqual({ role: 'Scout', count: 5, active: true });
    // Body retains the blank line after the closing fence (irrelevant for field parsing).
    expect(r?.body).toBe('\n# Body\n');
  });

  it('returns null when there is no frontmatter block', () => {
    expect(parseFrontmatter('# Just a heading\n\nsome text\n')).toBeNull();
  });

  it('yields empty fields (no crash) when the block is a bare scalar', () => {
    const r = parseFrontmatter('---\njust a scalar\n---\n\nbody\n');
    expect(r?.fields).toEqual({});
  });
});

describe('diffToUpdates', () => {
  const row: Row = { id: 'a1', name: 'Alpha', role: 'Scout', count: 5 };

  it('emits only changed, existing, non-system, non-pk columns', () => {
    const u = diffToUpdates(
      'agents',
      { id: 'a1' },
      { name: 'Alpha', role: 'Commander', count: 5, bogus: 'x' },
      row,
    );
    expect(u).toEqual([{ table: 'agents', pk: { id: 'a1' }, set: { role: 'Commander' } }]);
  });

  it('is type-tolerant: "5" vs 5 is not a change', () => {
    expect(diffToUpdates('agents', { id: 'a1' }, { count: '5' }, row)).toEqual([]);
  });

  it('never writes system or pk columns', () => {
    const u = diffToUpdates(
      'agents',
      { id: 'a1' },
      { id: 'hacked', created_at: 'x', name: 'Beta' },
      row,
    );
    expect(u).toEqual([{ table: 'agents', pk: { id: 'a1' }, set: { name: 'Beta' } }]);
  });

  it('returns [] when nothing meaningfully changed', () => {
    expect(diffToUpdates('agents', { id: 'a1' }, { name: 'Alpha' }, row)).toEqual([]);
  });
});

describe('deriveUpdatesFromFile', () => {
  const row: Row = { id: 'a1', name: 'Alpha', slug: 'alpha', role: 'Scout', status: 'active' };

  it('round-trips a frontmatter field change', () => {
    const content = '---\nrole: Commander\nstatus: active\n---\n\n# Alpha\n';
    expect(deriveUpdatesFromFile(content, row, { table: 'agents', pkCols: ['id'] })).toEqual([
      { table: 'agents', pk: { id: 'a1' }, set: { role: 'Commander' } },
    ]);
  });

  it('round-trips a body key: value change (covers edited markdown body content)', () => {
    const content = '# Alpha\n\nstatus: archived\n';
    expect(deriveUpdatesFromFile(content, row, { table: 'agents', pkCols: ['id'] })).toEqual([
      { table: 'agents', pk: { id: 'a1' }, set: { status: 'archived' } },
    ]);
  });

  it('returns [] for free-form prose with no parseable column (never guesses)', () => {
    const content = '# Alpha\n\nA free-form note about the agent with no structured pairs.\n';
    expect(deriveUpdatesFromFile(content, row, { table: 'agents', pkCols: ['id'] })).toEqual([]);
  });
});
