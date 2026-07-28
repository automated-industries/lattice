import { describe, expect, it } from 'vitest';
import {
  countMarginalLinks,
  publishMarginalLinksNote,
  type ImportRouteDeps,
} from '../../src/gui/import-routes.js';
import { FeedBus } from '../../src/gui/feed.js';
import type { ProposedSchema } from '../../src/import/types.js';

// The large-workbook per-sheet apply path aggregates marginal (low-confidence) links across every
// sheet and reports them ONCE, exactly like the single-plan path — a split import must not swallow
// a link the whole-source import would have surfaced. These pin the two helpers that path shares
// with the single-plan reporter, so the counting rule + the never-silent feed note stay in lockstep.

/**
 * A plan carrying two marginal links: one whose reference survived as a real scalar column on the
 * from-entity (a later connect COULD read it → counted) and one that did not (an array reference,
 * no column to read → not counted). Mirrors the reporter's "only scalar-column references count".
 */
function planWithMarginals(): ProposedSchema {
  return {
    entities: [
      {
        name: 'orders',
        sourceKey: 'orders',
        columns: [
          { name: 'sku', sourceKey: 'sku', type: 'text' },
          { name: 'vendor', sourceKey: 'vendor', type: 'text' },
        ],
        naturalKey: 'sku',
        naturalKeySource: 'sku',
        rowCount: 3,
        columnar: false,
      },
    ],
    dimensions: [],
    linkages: [],
    marginalLinks: [
      // Survives as the scalar `vendor` column on `orders` → counted.
      {
        kind: 'many-to-one',
        fromEntity: 'orders',
        fromField: 'vendor',
        toEntity: 'vendors',
        toKey: 'code',
        matched: 1,
        unresolved: 1,
        confidence: 0.5,
      },
      // No `tags` scalar column on `orders` (an array reference) → NOT counted.
      {
        kind: 'many-to-many',
        fromEntity: 'orders',
        fromField: 'tags',
        toEntity: 'tags',
        toKey: 'code',
        matched: 1,
        unresolved: 1,
        confidence: 0.5,
      },
    ],
    skipped: [],
  };
}

/** Minimal deps — only `feed` is read by publishMarginalLinksNote. */
function depsWith(feed: FeedBus): ImportRouteDeps {
  return { feed } as unknown as ImportRouteDeps;
}

describe('marginal-link reporting helpers (per-sheet path parity)', () => {
  it('counts only marginal links that survived as a scalar column', () => {
    expect(countMarginalLinks(planWithMarginals())).toBe(1);
  });

  it('counts zero when there are no marginal links', () => {
    const plan = planWithMarginals();
    plan.marginalLinks = [];
    expect(countMarginalLinks(plan)).toBe(0);
  });

  it('publishes ONE feed note for a positive count and nothing at all for zero', () => {
    const feed = new FeedBus();
    publishMarginalLinksNote(depsWith(feed), 0);
    expect(feed.recent(10)).toHaveLength(0);

    publishMarginalLinksNote(depsWith(feed), 3);
    const events = feed.recent(10);
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain('3 possible links');
    expect(events[0]!.summary).toContain('unconnected');
    // A general import note, not a row mutation.
    expect(events[0]!.table).toBeNull();
    expect(events[0]!.op).toBe('schema');
    expect(events[0]!.source).toBe('system');
  });
});
