import { describe, it, expect, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { ProvenanceImmutableError } from '../../src/schema/governance.js';

/**
 * p4a — governance: immutable provenance + the trust/verification workflow.
 */
describe('provenance (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('docs', {
      columns: { id: 'TEXT PRIMARY KEY', body: 'TEXT' },
      provenance: true,
      render: () => '',
      outputFile: 'd.md',
    });
    await db.init();
    return db;
  }

  it('adds provenance columns and auto-stamps ingested_at on insert', async () => {
    const d = await setup();
    await d.insert('docs', {
      id: 'd1',
      body: 'x',
      ingested_via: 'crawler',
      source_uri: 'https://e.com',
    });
    const row = await d.get('docs', 'd1');
    expect(row!.ingested_via).toBe('crawler');
    expect(row!.source_uri).toBe('https://e.com');
    expect(typeof row!.ingested_at).toBe('string'); // auto-stamped
  });

  it('rejects an update that touches a provenance column', async () => {
    const d = await setup();
    await d.insert('docs', { id: 'd1', body: 'x', source_uri: 'a' });
    await expect(d.update('docs', 'd1', { source_uri: 'b' })).rejects.toBeInstanceOf(
      ProvenanceImmutableError,
    );
    // a non-provenance update still works
    await d.update('docs', 'd1', { body: 'y' });
    expect((await d.get('docs', 'd1'))!.body).toBe('y');
    // provenance unchanged
    expect((await d.get('docs', 'd1'))!.source_uri).toBe('a');
  });

  it('honors a fields subset', async () => {
    db = new Lattice(':memory:');
    db.define('t', {
      columns: { id: 'TEXT PRIMARY KEY', v: 'TEXT' },
      provenance: { fields: ['source_uri'] },
      render: () => '',
      outputFile: 't.md',
    });
    await db.init();
    await db.insert('t', { id: 't1', v: 'x', source_uri: 's' });
    const row = await db.get('t', 't1');
    expect(row!.source_uri).toBe('s');
    expect('ingested_via' in row!).toBe(false);
  });
});

describe('trust / verification (SQLite)', () => {
  let db: Lattice | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function setup(defaultState?: 'unverified' | 'verified'): Promise<Lattice> {
    db = new Lattice(':memory:');
    db.define('items', {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
      trust: defaultState ? { defaultState } : true,
      render: () => '',
      outputFile: 'i.md',
    });
    await db.init();
    return db;
  }

  it('new rows default to unverified', async () => {
    const d = await setup();
    await d.insert('items', { id: 'i1', name: 'a' });
    expect((await d.get('items', 'i1'))!._trust_state).toBe('unverified');
  });

  it('markRowForReview moves a row to needs_review with a reason', async () => {
    const d = await setup();
    await d.insert('items', { id: 'i1', name: 'a' });
    await d.markRowForReview('items', 'i1', 'looks suspicious');
    const row = await d.get('items', 'i1');
    expect(row!._trust_state).toBe('needs_review');
    expect(row!._review_reason).toBe('looks suspicious');
    const review = await d.rowsNeedingReview('items');
    expect(review.map((r) => r.id)).toEqual(['i1']);
  });

  it('verifyRow moves a row to verified and stamps verifier + time', async () => {
    const d = await setup();
    await d.insert('items', { id: 'i1', name: 'a' });
    await d.markRowForReview('items', 'i1', 'check');
    await d.verifyRow('items', 'i1', 'alice');
    const row = await d.get('items', 'i1');
    expect(row!._trust_state).toBe('verified');
    expect(row!._verified_by).toBe('alice');
    expect(typeof row!._verified_at).toBe('string');
    expect(row!._review_reason).toBeNull(); // cleared
    const verified = await d.verifiedRows('items');
    expect(verified.map((r) => r.id)).toEqual(['i1']);
    expect(await d.rowsNeedingReview('items')).toHaveLength(0);
  });

  it('defaultState verified can be configured for a trusted source', async () => {
    const d = await setup('verified');
    await d.insert('items', { id: 'i1', name: 'a' });
    expect((await d.get('items', 'i1'))!._trust_state).toBe('verified');
  });

  it('verification methods throw on a table without trust config', async () => {
    db = new Lattice(':memory:');
    db.define('plain', {
      columns: { id: 'TEXT PRIMARY KEY' },
      render: () => '',
      outputFile: 'p.md',
    });
    await db.init();
    await db.insert('plain', { id: 'p1' });
    await expect(db.verifyRow('plain', 'p1')).rejects.toThrow(/trust/);
    await expect(db.rowsNeedingReview('plain')).rejects.toThrow(/trust/);
  });
});
