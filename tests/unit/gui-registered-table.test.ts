import { describe, it, expect } from 'vitest';
import { isRegisteredTable } from '../../src/gui/active-db.js';
import type { ActiveDb } from '../../src/gui/active-db.js';

/**
 * isRegisteredTable() gates whether a table can be read/queried by the row + read
 * routes. It must accept a table that was registered AFTER the workspace opened — a
 * connector or an external database defines its tables via db.defineLate post-open,
 * so those tables are in the LIVE registry but absent from the open-time validTables
 * snapshot. Without the live-registry fallback the sidebar (built from the live
 * registry) LISTS such a table while clicking it 404s "Unknown table" — the exact
 * list-vs-validation divergence this pins. Internal (__lattice_*) tables stay excluded
 * so the security boundary is unchanged.
 */

function fakeActive(snapshot: string[], registered: string[]): ActiveDb {
  return {
    validTables: new Set(snapshot),
    db: { getRegisteredTableNames: () => registered },
  } as unknown as ActiveDb;
}

describe('isRegisteredTable — live-registry fallback for post-open tables', () => {
  it('accepts a table already in the open-time validTables snapshot', () => {
    const active = fakeActive(['items'], ['items']);
    expect(isRegisteredTable(active, 'items')).toBe(true);
  });

  it('accepts a table registered AFTER open (connector / external DB), absent from the snapshot', () => {
    // The regressed case: gmail_labels is defineLate'd on connector connect, so it is
    // live-registered but NOT in the snapshot. Pre-fix the gates checked only the
    // snapshot (validTables.has) → false → "Unknown table: gmail_labels" on click.
    const active = fakeActive(['items'], ['items', 'gmail_labels']);
    expect(isRegisteredTable(active, 'gmail_labels')).toBe(true);
  });

  it('rejects a table that exists in neither the snapshot nor the live registry', () => {
    const active = fakeActive(['items'], ['items']);
    expect(isRegisteredTable(active, 'nope')).toBe(false);
  });

  it('never exposes internal __lattice_* / _lattice* tables even if live-registered', () => {
    const active = fakeActive([], ['__lattice_connectors', '_lattice_meta']);
    expect(isRegisteredTable(active, '__lattice_connectors')).toBe(false);
    expect(isRegisteredTable(active, '_lattice_meta')).toBe(false);
  });
});
