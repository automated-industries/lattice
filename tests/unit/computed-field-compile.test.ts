import { describe, it, expect } from 'vitest';
import { compileComputedField } from '../../src/schema/computed-field.js';

/**
 * The #10 computed-COLUMN compiler: a serializable computed field (alias/calc/…) →
 * a bounded SQL scalar expression the runtime recomputes on write. Same-row
 * deterministic kinds compile to SQL (over the row's own columns); non-same-row /
 * non-deterministic kinds are returned DEFERRED (produced by a later mechanism).
 */
const COLS = new Set(['priority', 'title', 'qty', 'price']);

describe('compileComputedField', () => {
  it('same-row alias → the quoted source column', () => {
    const c = compileComputedField(
      'ticket',
      'headline',
      { kind: 'alias', source: 'title' },
      COLS,
      'sqlite',
    );
    expect(c).toEqual({ column: 'headline', sql: '"title"', deps: ['title'] });
  });

  it('same-row calc → emitted SQL over the row columns, with its deps', () => {
    const c = compileComputedField(
      'ticket',
      'is_urgent',
      { kind: 'calc', expr: 'priority >= 3' },
      COLS,
      'sqlite',
    );
    expect(c.deferred).toBeUndefined();
    expect(c.column).toBe('is_urgent');
    expect(c.sql).toContain('"priority"');
    expect(c.deps).toEqual(['priority']);
  });

  it('calc dedupes deps and references only same-row columns', () => {
    const c = compileComputedField(
      'line',
      'total',
      { kind: 'calc', expr: 'qty * price + qty' },
      COLS,
      'postgres',
    );
    expect(c.deps.sort()).toEqual(['price', 'qty']);
    expect(c.sql).toContain('"qty"');
    expect(c.sql).toContain('"price"');
  });

  it('ai_classify → deferred: ai, carries its input as a dep + a classify plan', () => {
    const cls = compileComputedField(
      'doc',
      'category',
      { kind: 'ai_classify', input: 'title', prompt: 'p', labels: ['a', 'b'] },
      COLS,
      'sqlite',
    );
    expect(cls.deferred).toBe('ai');
    // The input column is surfaced as a dep so a write to it invalidates the AI cell.
    expect(cls.deps).toEqual(['title']);
    expect(cls.ai).toEqual({
      kind: 'classify',
      inputs: ['title'],
      prompt: 'p',
      labels: ['a', 'b'],
      model: 'default',
    });
  });

  it('ai_transform → deferred: ai, dedupes inputs into deps + a transform plan', () => {
    const tr = compileComputedField(
      'doc',
      'summary',
      {
        kind: 'ai_transform',
        inputs: ['title', 'priority', 'title'],
        prompt: 'p',
        model: 'cheapest',
      },
      COLS,
      'sqlite',
    );
    expect(tr.deferred).toBe('ai');
    expect(tr.deps).toEqual(['title', 'priority']);
    expect(tr.ai).toEqual({
      kind: 'transform',
      inputs: ['title', 'priority'],
      prompt: 'p',
      model: 'cheapest',
    });
    expect(tr.aggregate).toBeUndefined();
  });

  it('an AI input referencing an unknown / path column fails loudly', () => {
    expect(() =>
      compileComputedField(
        'doc',
        'x',
        { kind: 'ai_classify', input: 'nope', prompt: 'p', labels: ['a'] },
        COLS,
        'sqlite',
      ),
    ).toThrow(/not a column/);
    expect(() =>
      compileComputedField(
        'doc',
        'x',
        { kind: 'ai_transform', inputs: ['assignee.team.name'], prompt: 'p' },
        COLS,
        'sqlite',
      ),
    ).toThrow(/belongsTo path/);
  });

  it('aggregate → deferred: aggregate, parses via into a junction/remote/fn plan', () => {
    const c = compileComputedField(
      'ticket',
      'tag_count',
      { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'count' },
      COLS,
      'sqlite',
    );
    expect(c.deferred).toBe('aggregate');
    expect(c.deps).toEqual([]);
    expect(c.aggregate).toEqual({ junction: 'ticket_tags', remote: 'tag', fn: 'count' });
  });

  it('aggregate with a value fn carries its column; sum without a column fails loudly', () => {
    const c = compileComputedField(
      'ticket',
      'points',
      { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'sum', column: 'weight' },
      COLS,
      'sqlite',
    );
    expect(c.aggregate).toEqual({
      junction: 'ticket_tags',
      remote: 'tag',
      fn: 'sum',
      column: 'weight',
    });
    expect(() =>
      compileComputedField(
        'ticket',
        'points',
        { kind: 'aggregate', via: 'ticket_tags.tag', fn: 'sum' },
        COLS,
        'sqlite',
      ),
    ).toThrow(/requires a `column`/);
    expect(() =>
      compileComputedField(
        'ticket',
        'points',
        { kind: 'aggregate', via: 'bad_no_dot', fn: 'count' },
        COLS,
        'sqlite',
      ),
    ).toThrow(/invalid `via`/);
  });

  it('a belongsTo-path alias / calc → deferred: path (not same-row)', () => {
    const a = compileComputedField(
      'ticket',
      'team',
      { kind: 'alias', source: 'assignee.team.name' },
      COLS,
      'sqlite',
    );
    expect(a.deferred).toBe('path');
    const c = compileComputedField(
      'ticket',
      'team_calc',
      { kind: 'calc', expr: 'assignee.team.name' },
      COLS,
      'sqlite',
    );
    expect(c.deferred).toBe('path');
  });

  it('an alias to an unknown same-row column fails loudly', () => {
    expect(() =>
      compileComputedField('ticket', 'x', { kind: 'alias', source: 'nope' }, COLS, 'sqlite'),
    ).toThrow(/not a column/);
  });

  it('a calc referencing an unknown same-row column fails loudly', () => {
    expect(() =>
      compileComputedField('ticket', 'x', { kind: 'calc', expr: 'nope + 1' }, COLS, 'sqlite'),
    ).toThrow();
  });
});
