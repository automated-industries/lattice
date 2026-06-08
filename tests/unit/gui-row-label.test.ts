import { describe, it, expect } from 'vitest';
import { rowLabel } from '../../src/gui/mutations.js';

/**
 * `rowLabel` (server) is mirrored by `fsDisplayName` in src/gui/app/script.ts
 * (client) — the client can't import server TS, the same constraint as the
 * documented `isJunction` mirror. This pins the priority contract so the two
 * can't silently drift: a card and its activity-feed bubble must name a row the
 * same way. If you change the priority order here, change `fsDisplayName` too.
 */
describe('rowLabel (mirrored by the client fsDisplayName — keep in lockstep)', () => {
  it('prefers the title-ish columns in order', () => {
    expect(rowLabel({ name: 'Acme', title: 'ignored' })).toBe('Acme');
    expect(rowLabel({ title: 'A Title', subject: 'ignored' })).toBe('A Title');
    expect(rowLabel({ label: 'A Label' })).toBe('A Label');
    expect(rowLabel({ original_name: 'invoice.pdf' })).toBe('invoice.pdf');
    expect(rowLabel({ subject: 'Re: hello' })).toBe('Re: hello');
  });

  it('falls back to a snippet of a body/description field', () => {
    expect(rowLabel({ description: 'a short description' })).toBe('a short description');
    const long = 'x'.repeat(200);
    const out = rowLabel({ body: long });
    expect(out?.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  });

  it('falls back to the first meaningful cell (skipping id / *_id / *_at)', () => {
    expect(rowLabel({ id: 'r1', invoice_number: 'INV-114', vendor: 'Acme' })).toBe('INV-114');
    expect(rowLabel({ id: 'r1', created_at: 'x', status: 'open' })).toBe('open');
  });

  it('returns null when there is nothing human to show', () => {
    expect(rowLabel({ id: 'r1', deleted_at: null })).toBeNull();
    expect(rowLabel({ id: 'r1', project_id: 'fk-uuid' })).toBeNull(); // foreign keys skipped
    expect(rowLabel(null)).toBeNull();
    expect(rowLabel('not an object')).toBeNull();
  });

  it('numbers are usable labels', () => {
    expect(rowLabel({ id: 'r1', total: 6400 })).toBe('6400');
  });
});
