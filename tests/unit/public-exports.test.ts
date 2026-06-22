import { describe, it, expect } from 'vitest';
import * as lattice from '../../src/index.js';

/**
 * Additive-only guard for the public API surface.
 *
 * 4.x promises that an existing caller keeps working across minor releases — the
 * public surface only GROWS. This snapshots every named export from the package
 * entrypoint. A REMOVED or RENAMED export breaks the snapshot, which is an
 * additive-only violation (a breaking change that must wait for a major bump). A
 * NEW export also breaks the snapshot; that is fine — update the snapshot in the
 * same PR, where the diff makes the surface change reviewable and confirms it is
 * purely additive.
 */
describe('public API surface (additive-only)', () => {
  it('exports only grow — no removal/rename without a snapshot update', () => {
    const names = Object.keys(lattice).sort();
    expect(names).toMatchSnapshot();
  });

  it('keeps the load-bearing public surface present', () => {
    // A hard floor independent of the snapshot: the names consumers build on must
    // always exist, so an accidental snapshot "update" can't quietly drop them.
    for (const name of ['Lattice', 'evaluateRetrieval', 'benchmarkRetrieval', 'checkSlos']) {
      expect(lattice).toHaveProperty(name);
    }
  });
});
