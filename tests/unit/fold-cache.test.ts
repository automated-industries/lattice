/**
 * Incremental fold cache (Stage 4). Memoizes the per-viewer compile and
 * re-renders only on a real change — a new observation for the row, or a shift in
 * the viewer's visible-source set. Caches per (row, viewer), never over-evicts.
 */
import { describe, it, expect } from 'vitest';
import { FoldCache } from '../../src/cloud/fold-cache.js';
import type { Observation, Viewer } from '../../src/cloud/fold.js';

const ground = { id: 'c1', phone: 'gt' };
const obs: Observation = {
  attribute: 'phone',
  value: 'enriched',
  createdAt: '2026-01-01T00:00:00Z',
  changeKind: 'derived',
  sourceRef: ['F'],
};
const v = (...s: string[]): Viewer => ({ visibleSources: new Set(s) });

describe('FoldCache', () => {
  it('memoizes a compile and reuses it (same object on a hit)', () => {
    const c = new FoldCache();
    const first = c.get('c1', ground, [obs], v('F'));
    const second = c.get('c1', ground, [obs], v('F'));
    expect(second).toBe(first); // identity → served from cache, not recomputed
    expect(first.phone).toBe('enriched');
    expect(c.size).toBe(1);
  });

  it('keys per viewer — two viewers get two cached versions', () => {
    const c = new FoldCache();
    const seer = c.get('c1', ground, [obs], v('F'));
    const blind = c.get('c1', ground, [obs], v());
    expect(seer.phone).toBe('enriched');
    expect(blind.phone).toBe('gt');
    expect(c.size).toBe(2);
  });

  it('a changed visible-source set is a cache miss (recompiles)', () => {
    const c = new FoldCache();
    const before = c.get('c1', ground, [obs], v());
    const after = c.get('c1', ground, [obs], v('F')); // F now shared
    expect(before).not.toBe(after);
    expect(before.phone).toBe('gt');
    expect(after.phone).toBe('enriched');
  });

  it('invalidateRow drops every cached version of that row only', () => {
    const c = new FoldCache();
    c.get('c1', ground, [obs], v('F'));
    c.get('c1', ground, [obs], v());
    c.get('c2', { id: 'c2', phone: 'x' }, [], v('F'));
    expect(c.size).toBe(3);
    c.invalidateRow('c1');
    expect(c.size).toBe(1); // only c2 remains
    // After invalidation a new observation is reflected.
    const updated: Observation = { ...obs, value: 'v2', createdAt: '2026-02-01T00:00:00Z' };
    expect(c.get('c1', ground, [updated], v('F')).phone).toBe('v2');
  });
});
