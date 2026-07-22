import { describe, expect, it } from 'vitest';
import { deriveTier, shapeToken } from '../../src/gui/planner/run.js';
import type { IntrospectDb } from '../../src/gui/planner/introspect.js';

describe('data-model planner — run helpers', () => {
  it('deriveTier respects precedence computed > junction > source > lattice', () => {
    expect(
      deriveTier({
        computed: true,
        junction: true,
        connected: true,
        hasSourceCol: true,
        isFiles: true,
      }),
    ).toBe('computed');
    expect(
      deriveTier({
        computed: false,
        junction: true,
        connected: true,
        hasSourceCol: false,
        isFiles: false,
      }),
    ).toBe('junction');
    expect(
      deriveTier({
        computed: false,
        junction: false,
        connected: true,
        hasSourceCol: false,
        isFiles: false,
      }),
    ).toBe('source');
    expect(
      deriveTier({
        computed: false,
        junction: false,
        connected: false,
        hasSourceCol: true,
        isFiles: false,
      }),
    ).toBe('source');
    expect(
      deriveTier({
        computed: false,
        junction: false,
        connected: false,
        hasSourceCol: false,
        isFiles: true,
      }),
    ).toBe('source');
    expect(
      deriveTier({
        computed: false,
        junction: false,
        connected: false,
        hasSourceCol: false,
        isFiles: false,
      }),
    ).toBe('lattice');
  });

  it('shapeToken is stable for the same shape, changes on a column add, and ignores hidden tables', () => {
    const mk = (cols: Record<string, Record<string, string>>): IntrospectDb =>
      ({
        getRegisteredTableNames: () => Object.keys(cols),
        getRegisteredColumns: (t: string) => cols[t] ?? null,
        getPrimaryKey: () => ['id'],
        isComputedTable: () => false,
        getConnectedSource: () => undefined,
        connectedTables: () => [],
        query: async () => [],
        boundedCount: async () => 0,
      }) as IntrospectDb;

    const a = mk({ orders: { id: 'text', total: 'real' }, _lattice_gui_meta: { id: 'text' } });
    const sameShapeDifferentOrder = mk({
      _lattice_gui_meta: { id: 'text' },
      orders: { total: 'real', id: 'text' },
    });
    const extraColumn = mk({ orders: { id: 'text', total: 'real', tax: 'real' } });

    expect(shapeToken(a)).toBe(shapeToken(sameShapeDifferentOrder)); // order-independent, hidden table ignored
    expect(shapeToken(a)).not.toBe(shapeToken(extraColumn)); // a shape change advances the token
  });
});
