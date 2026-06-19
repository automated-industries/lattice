import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';

let db: Lattice | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe('PK codec — byte-identical serialized pk (characterization)', () => {
  // ── Path A: insert()/upsert() RETURN the canonical serialized pk ──────────

  it('single-column custom PK serializes to the bare value (no separator)', async () => {
    db = new Lattice(':memory:');
    db.define('posts', {
      columns: { slug: 'TEXT PRIMARY KEY', title: 'TEXT NOT NULL' },
      primaryKey: 'slug',
      render: () => '',
      outputFile: 'posts.md',
    });
    await db.init();

    const pk = await db.insert('posts', { slug: 'hello-world', title: 'Hello World' });
    expect(pk).toBe('hello-world'); // bare value, NO tab
  });

  it('default id PK round-trips its value as the bare pk', async () => {
    db = new Lattice(':memory:');
    db.define('bots', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      render: () => '',
      outputFile: 'bots.md',
    });
    await db.init();

    const pk = await db.insert('bots', { id: 'bot-1', name: 'Alpha' });
    expect(pk).toBe('bot-1'); // single id col → bare value
  });

  it('composite PK serializes to TAB-joined values in DECLARED order', async () => {
    db = new Lattice(':memory:');
    db.define('seats', {
      columns: {
        event_id: 'TEXT NOT NULL',
        seat_no: 'INTEGER NOT NULL',
        holder: 'TEXT',
      },
      tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
      primaryKey: ['event_id', 'seat_no'],
      render: () => '',
      outputFile: 'seats.md',
    });
    await db.init();

    const pk = await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
    expect(pk).toBe('evt-1\t5'); // literal TAB (U+0009), declared order [event_id, seat_no]
    expect(pk).toBe('evt-1' + String.fromCharCode(9) + '5'); // pin the separator byte explicitly
    expect(pk.split('\t')).toEqual(['evt-1', '5']); // INTEGER 5 → String() → '5'
  });

  // ── Path B: changelog history() round-trips the WRITE pk against the LOOKUP pk ──

  it('single-key changelog history() keys on the bare-value pk', async () => {
    db = new Lattice(':memory:');
    db.define('notes', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      changelog: true,
      render: () => '',
      outputFile: 'notes.md',
    });
    await db.init();

    await db.insert('notes', { id: 'n1', body: 'thin' }); // _serializeRowPk → 'n1'
    await db.update('notes', 'n1', { body: 'fuller' }); // _serializePkLookup('n1') → 'n1'
    const hist = await db.history('notes', 'n1'); // lookup must serialize identically
    expect(hist.some((h) => h.operation === 'update')).toBe(true);
  });

  it('composite changelog history() proves write-side and lookup-side agree on the tab-joined pk', async () => {
    db = new Lattice(':memory:');
    db.define('seats', {
      columns: {
        event_id: 'TEXT NOT NULL',
        seat_no: 'INTEGER NOT NULL',
        holder: 'TEXT',
      },
      tableConstraints: ['PRIMARY KEY (event_id, seat_no)'],
      primaryKey: ['event_id', 'seat_no'],
      changelog: true,
      render: () => '',
      outputFile: 'seats.md',
    });
    await db.init();

    // WRITE side: insert serializes via serializeRowPk → 'evt-1\t5'
    const writePk = await db.insert('seats', { event_id: 'evt-1', seat_no: 5, holder: 'Alice' });
    expect(writePk).toBe('evt-1\t5');

    // LOOKUP side: address update by the composite Record → serializePkLookup → must equal 'evt-1\t5'
    await db.update('seats', { event_id: 'evt-1', seat_no: 5 }, { holder: 'Bob' });

    // Read history by the SERIALIZED string — only returns the update if both sides produced 'evt-1\t5'
    const hist = await db.history('seats', 'evt-1\t5');
    expect(hist.some((h) => h.operation === 'update')).toBe(true);

    // And the same lookup via the verbatim string id path is identical
    const histByString = await db.history('seats', writePk);
    expect(histByString.some((h) => h.operation === 'update')).toBe(true);
  });
});
