import { describe, it, expect } from 'vitest';
import { setRowVisibility } from '../../src/cloud/members.js';
import type { Lattice } from '../../src/lattice.js';

/**
 * Regression — the GUI "Specific people…" flow pre-flips a row to `custom`
 * visibility before listing members. setRowVisibility's allow-set omitted
 * `custom` (the underlying `lattice_set_row_visibility` RLS function accepts
 * private | everyone | custom), so the flip threw `invalid visibility "custom"`
 * and the member checklist failed to load. The wrapper must accept the same set
 * the RLS function does and forward the value through.
 */
function stubDb(): { db: Lattice; calls: { sql: string; params?: unknown[] }[] } {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const db = {
    getDialect: () => 'postgres',
    adapter: {
      run: (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
      },
    },
  } as unknown as Lattice;
  return { db, calls };
}

describe('setRowVisibility — custom ("Specific people…") regression', () => {
  it('accepts custom and forwards it to lattice_set_row_visibility', async () => {
    const { db, calls } = stubDb();
    await setRowVisibility(db, 'agents', 'agent-1', 'custom');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('lattice_set_row_visibility');
    expect(calls[0].params).toEqual(['agents', 'agent-1', 'custom']);
  });

  it('still accepts private and everyone', async () => {
    for (const v of ['private', 'everyone']) {
      const { db, calls } = stubDb();
      await setRowVisibility(db, 't', 'pk', v);
      expect(calls[0].params).toEqual(['t', 'pk', v]);
    }
  });

  it('rejects an unknown visibility with a clear message', async () => {
    const { db } = stubDb();
    await expect(setRowVisibility(db, 't', 'pk', 'public')).rejects.toThrow(
      /invalid visibility "public" \(expected private \| everyone \| custom\)/,
    );
  });
});
