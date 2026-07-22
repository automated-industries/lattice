import { describe, expect, it } from 'vitest';
import {
  canonicalizeValue,
  naturalType,
  profileTable,
  type TableStructural,
} from '../../src/gui/planner/introspect.js';

// One logical dataset, expressed the way each driver returns it. This is the
// cross-dialect parity proof (G3): the two representations MUST canonicalize to
// the same TableProfile even though the raw JS types differ per engine.
const struct: TableStructural = {
  name: 'members',
  tier: 'lattice',
  columns: [
    { name: 'id', sqlType: 'text' },
    { name: 'email', sqlType: 'text' },
    { name: 'age', sqlType: 'integer' },
    { name: 'active', sqlType: 'boolean' },
    { name: 'balance', sqlType: 'numeric' },
    { name: 'joined', sqlType: 'timestamp' },
    { name: 'note', sqlType: 'text' },
  ],
  primaryKey: ['id'],
  relations: [],
  hasDefinition: false,
  rowCount: 3,
  rowCountCapped: false,
};

// better-sqlite3 shapes: booleans as 0/1, numerics as JS numbers, timestamps as ISO text.
const sqliteRows = [
  {
    id: 'a',
    email: 'x@y.com',
    age: 30,
    active: 1,
    balance: 12.5,
    joined: '2026-01-02T03:04:05.000Z',
    note: 'hi',
  },
  {
    id: 'b',
    email: 'p@q.com',
    age: 40,
    active: 0,
    balance: 7,
    joined: '2026-02-03T04:05:06.000Z',
    note: 'hi',
  },
  {
    id: 'c',
    email: 'm@n.com',
    age: 30,
    active: 1,
    balance: 7,
    joined: '2026-02-03T04:05:06.000Z',
    note: '',
  },
];

// node-pg shapes: booleans as true/false, numeric/decimal as strings, timestamps as Date objects.
const pgRows = [
  {
    id: 'a',
    email: 'x@y.com',
    age: 30,
    active: true,
    balance: '12.5',
    joined: new Date('2026-01-02T03:04:05.000Z'),
    note: 'hi',
  },
  {
    id: 'b',
    email: 'p@q.com',
    age: 40,
    active: false,
    balance: '7',
    joined: new Date('2026-02-03T04:05:06.000Z'),
    note: 'hi',
  },
  {
    id: 'c',
    email: 'm@n.com',
    age: 30,
    active: true,
    balance: '7',
    joined: new Date('2026-02-03T04:05:06.000Z'),
    note: '',
  },
];

describe('data-model planner — introspect (G3 cross-dialect canonicalization)', () => {
  it('produces a byte-identical TableProfile from SQLite-shaped and Postgres-shaped rows', () => {
    const fromSqlite = profileTable(struct, sqliteRows);
    const fromPg = profileTable(struct, pgRows);
    expect(fromPg).toEqual(fromSqlite);
    expect(JSON.stringify(fromPg)).toEqual(JSON.stringify(fromSqlite));
  });

  it('infers the natural type through each dialect representation', () => {
    const p = profileTable(struct, pgRows);
    const typeOf = (n: string): string => p.columns.find((c) => c.name === n)!.inferredType;
    expect(typeOf('age')).toBe('integer'); // int both ways
    expect(typeOf('active')).toBe('boolean'); // 0/1 ↔ true/false
    expect(typeOf('balance')).toBe('real'); // number ↔ numeric-string, non-integer
    expect(typeOf('joined')).toBe('datetime'); // ISO text ↔ Date object
    expect(typeOf('email')).toBe('text');
  });

  it('computes null rate and distinct sampling deterministically', () => {
    const p = profileTable(struct, sqliteRows);
    const note = p.columns.find((c) => c.name === 'note')!;
    expect(note.nullRate).toBeCloseTo(1 / 3); // one empty string counts as null
    expect(note.distinctSampled).toBe(1); // only 'hi'
    const email = p.columns.find((c) => c.name === 'email')!;
    expect(email.distinctSampled).toBe(3);
  });

  it('picks a natural key from a unique non-freetext column (not the system id)', () => {
    const p = profileTable(struct, pgRows);
    expect(p.naturalKey).toBe('email');
    expect(p.sampledRowCount).toBe(3);
    expect(p.columns.find((c) => c.name === 'id')!.isPrimaryKey).toBe(true);
  });

  it('canonicalizeValue: declared type drives coercion, not the runtime typeof', () => {
    expect(canonicalizeValue('12.5', 'numeric')).toBe(12.5);
    expect(canonicalizeValue(1, 'boolean')).toBe(true);
    expect(canonicalizeValue('f', 'boolean')).toBe(false);
    expect(canonicalizeValue(new Date('2026-01-02T00:00:00.000Z'), 'timestamp')).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(canonicalizeValue('keep', 'text')).toBe('keep');
    expect(canonicalizeValue(null, 'integer')).toBe(null);
  });

  it('naturalType: recognizes numbers/dates stored as TEXT (the retype signal)', () => {
    expect(naturalType(['10', '20', '30'])).toBe('integer');
    expect(naturalType(['1.5', '2'])).toBe('real');
    expect(naturalType(['2026-01-02', '2026-03-04'])).toBe('date');
    expect(naturalType(['alpha', 'beta'])).toBe('text');
    expect(naturalType([])).toBe('text');
  });
});
