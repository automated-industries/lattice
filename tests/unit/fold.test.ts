/**
 * Per-viewer fold (Stage 3 local compile). Proves the centerpiece invariants on
 * the pure function: a derived value appears only for a viewer who can see its
 * source, revocation reverts it with no residue, the latest visible observation
 * per attribute wins, the fold is additive (an invisible observation never
 * changes the result), and two viewers get two correct versions.
 */
import { describe, it, expect } from 'vitest';
import {
  foldEntity,
  observationVisible,
  observationsFromChange,
  type Observation,
  type Viewer,
} from '../../src/cloud/fold.js';

const ground = { id: 'c1', name: 'Acme', phone: 'gt-phone' };

const enrichedPhone: Observation = {
  attribute: 'phone',
  value: 'enriched-from-F',
  createdAt: '2026-01-01T00:00:00Z',
  changeKind: 'derived',
  sourceRef: ['F'],
};

function viewer(...sources: string[]): Viewer {
  return { visibleSources: new Set(sources) };
}

describe('observationVisible', () => {
  it('ground-truth is always visible', () => {
    expect(observationVisible({ ...enrichedPhone, changeKind: 'ground_truth' }, viewer())).toBe(
      true,
    );
  });
  it('a derived value needs EVERY source visible', () => {
    const obs = { ...enrichedPhone, sourceRef: ['F', 'G'] };
    expect(observationVisible(obs, viewer('F'))).toBe(false);
    expect(observationVisible(obs, viewer('F', 'G'))).toBe(true);
  });
  it('an unsourced derived observation fails closed (hidden)', () => {
    expect(observationVisible({ ...enrichedPhone, sourceRef: [] }, viewer('F'))).toBe(false);
  });
});

describe('foldEntity', () => {
  it('shows the derived value to a viewer who can see the source', () => {
    expect(foldEntity(ground, [enrichedPhone], viewer('F')).phone).toBe('enriched-from-F');
  });

  it('revocation is structural: without the source, the value reverts with no residue', () => {
    const folded = foldEntity(ground, [enrichedPhone], viewer());
    expect(folded.phone).toBe('gt-phone'); // back to ground truth
    expect(folded).toEqual(ground); // nothing left behind
  });

  it('two viewers get two correct versions of the same entity', () => {
    const seer = foldEntity(ground, [enrichedPhone], viewer('F'));
    const blind = foldEntity(ground, [enrichedPhone], viewer());
    expect(seer.phone).toBe('enriched-from-F');
    expect(blind.phone).toBe('gt-phone');
  });

  it('latest visible observation per attribute wins', () => {
    const older: Observation = {
      ...enrichedPhone,
      value: 'old',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const newer: Observation = {
      ...enrichedPhone,
      value: 'new',
      createdAt: '2026-02-01T00:00:00Z',
      sourceRef: ['G'],
    };
    // Viewer sees only G → the newer (G-derived) wins.
    expect(foldEntity(ground, [older, newer], viewer('F', 'G')).phone).toBe('new');
    // Viewer sees only F → only the older is visible, so it wins over an
    // invisible newer one (no leak of the G-derived value).
    expect(foldEntity(ground, [older, newer], viewer('F')).phone).toBe('old');
  });

  it('is additive: an invisible observation never changes the result', () => {
    const base = foldEntity(ground, [], viewer('F'));
    const withHidden = foldEntity(
      ground,
      [{ ...enrichedPhone, sourceRef: ['SECRET'] }],
      viewer('F'),
    );
    expect(withHidden).toEqual(base);
  });

  it('does not mutate the ground projection', () => {
    const g = { ...ground };
    foldEntity(g, [enrichedPhone], viewer('F'));
    expect(g).toEqual(ground);
  });
});

describe('observationsFromChange', () => {
  it('expands a change-log entry into per-attribute observations', () => {
    const obs = observationsFromChange({
      changes: { phone: 'x', email: 'y' },
      createdAt: '2026-01-01T00:00:00Z',
      changeKind: 'derived',
      sourceRef: ['F'],
    });
    expect(obs).toHaveLength(2);
    expect(obs.map((o) => o.attribute).sort()).toEqual(['email', 'phone']);
    expect(obs.every((o) => o.changeKind === 'derived')).toBe(true);
  });
  it('a null changes map yields no observations', () => {
    expect(observationsFromChange({ changes: null, createdAt: '2026-01-01T00:00:00Z' })).toEqual(
      [],
    );
  });
});
