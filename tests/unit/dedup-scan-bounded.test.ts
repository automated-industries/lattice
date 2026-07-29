import { describe, it, expect } from 'vitest';
import {
  findDuplicateGroups,
  MAX_FUZZY_TEXT_CHARS,
  type DedupItem,
  type DedupScanResult,
} from '../../src/dedup/index.js';
import { bigramDice, bigramProfile, diceFromProfiles } from '../../src/dedup/match.js';

/** Build an item with a stable, ordered createdAt so survivor order is deterministic. */
function item(
  id: string,
  key: string,
  seq: number,
  extra: Partial<Pick<DedupItem, 'fuzzyText' | 'blockKey'>> = {},
): DedupItem {
  return {
    id,
    key,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    ...extra,
  };
}

describe('bounded duplicate scan (pure module)', () => {
  it('diceFromProfiles scores identically to bigramDice on the same strings', () => {
    const pairs: [string, string][] = [
      ['northwind traders', 'northwind traders llc'],
      ['acme inc', 'acme inc'],
      ['a', 'ab'],
      ['', 'x'],
      ['hello world', 'goodbye moon'],
    ];
    for (const [a, b] of pairs) {
      expect(diceFromProfiles(bigramProfile(a), bigramProfile(b))).toBeCloseTo(
        bigramDice(a, b),
        12,
      );
    }
  });

  it('preserves exact + near grouping semantics on a small clean input', async () => {
    const items: DedupItem[] = [
      item('a1', 'acme inc', 1),
      item('a2', 'acme inc', 2),
      item('b1', 'northwind traders', 3),
      item('b2', 'northwind traders llc', 4),
      item('c1', 'zzz unrelated', 5),
    ];
    const { groups, scan } = await findDuplicateGroups(items, { fuzzy: true });
    const exact = groups.filter((g) => g.kind === 'exact');
    const near = groups.filter((g) => g.kind === 'near');
    expect(exact).toHaveLength(1);
    expect(exact[0]?.ids).toEqual(['a1', 'a2']);
    expect(near).toHaveLength(1);
    expect(near[0]?.ids).toEqual(['b1', 'b2']);
    // The group score is the real pairwise Dice, unchanged by profile precomputation.
    expect(near[0]?.score).toBeCloseTo(bigramDice('northwind traders', 'northwind traders llc'));
    expect(scan.complete).toBe(true);
    expect(scan.pairsSkipped).toBe(0);
    expect(scan.reason).toBeUndefined();
    // Only the b1/b2 candidate pair needed scoring (c1 sits alone in its block).
    expect(scan.pairsCompared).toBe(1);
  });

  it('resolves a degenerate identical-text block linearly — zero scored pairs', async () => {
    // The old failure shape: many rows whose comparison text is byte-identical
    // all landing in one candidate block. Full pairwise would be n·(n−1)/2.
    const text = 'the same boilerplate document body '.repeat(10);
    const items: DedupItem[] = [];
    for (let i = 0; i < 500; i++) {
      items.push(
        item(`i${String(i).padStart(3, '0')}`, `k${String(i)}`, i, {
          fuzzyText: text,
          blockKey: 'B',
        }),
      );
    }
    const { groups, scan } = await findDuplicateGroups(items, { fuzzy: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('near');
    expect(groups[0]?.score).toBe(1);
    expect(groups[0]?.ids).toHaveLength(500);
    expect(groups[0]?.ids[0]).toBe('i000'); // oldest first
    expect(scan.complete).toBe(true);
    expect(scan.pairsCompared).toBe(0); // resolved by text identity, never scored
  });

  it('caps pairs per block and reports the truncation honestly (never silently)', async () => {
    // 30 distinct texts sharing their first 16 chars: the refinement split
    // cannot separate them, so the hard cap applies. 30·29/2 = 435 pairs total.
    const items: DedupItem[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(
        item(`r${String(i).padStart(2, '0')}`, `key${String(i)}`, i, {
          fuzzyText: 'sameprefix16char-' + i.toString(36).repeat(5),
          blockKey: 'B',
        }),
      );
    }
    const { scan } = await findDuplicateGroups(items, {
      fuzzy: true,
      threshold: 0.95,
      maxPairsPerBlock: 100,
    });
    expect(scan.complete).toBe(false);
    expect(scan.reason).toBe('pair_cap');
    expect(scan.pairsCompared).toBe(100);
    expect(scan.pairsSkipped).toBe(335);
    expect(scan.blocksTruncated).toBe(1);
    expect(scan.rowsInTruncatedBlocks).toBe(30);
  });

  it('sub-splits an oversized block on a longer prefix before capping, keeping recall', async () => {
    // Two 12-member clusters share one block key; 24·23/2 = 276 pairs exceeds the
    // cap of 200, but the 16-char-prefix refinement separates the clusters into
    // two fully-scannable parts of 66 pairs each. Each cluster contains one true
    // near-duplicate pair the scan must still find.
    const tails = [
      'budget summary',
      'personnel roster',
      'meeting minutes',
      'travel expenses',
      'vendor contracts',
      'audit findings',
      'press releases',
      'shipping manifest',
      'inventory ledger',
      'training schedule',
    ];
    const items: DedupItem[] = [];
    let seq = 0;
    for (const prefix of ['alpha cluster 00 ', 'omega cluster 99 ']) {
      const tag = prefix[0] ?? 'x';
      items.push(
        item(`${tag}v1`, `${tag}kv1`, seq++, {
          fuzzyText: prefix + 'quarterly report v1',
          blockKey: 'B',
        }),
      );
      items.push(
        item(`${tag}v2`, `${tag}kv2`, seq++, {
          fuzzyText: prefix + 'quarterly report v2',
          blockKey: 'B',
        }),
      );
      tails.forEach((t, i) => {
        items.push(
          item(`${tag}t${String(i)}`, `${tag}kt${String(i)}`, seq++, {
            fuzzyText: prefix + t,
            blockKey: 'B',
          }),
        );
      });
    }
    const { groups, scan } = await findDuplicateGroups(items, {
      fuzzy: true,
      threshold: 0.95,
      maxPairsPerBlock: 200,
    });
    expect(scan.complete).toBe(true);
    expect(scan.pairsCompared).toBe(132); // 66 + 66 — split happened, no cap needed
    const nearIds = groups.filter((g) => g.kind === 'near').map((g) => g.ids.slice().sort());
    expect(nearIds).toContainEqual(['av1', 'av2']);
    expect(nearIds).toContainEqual(['ov1', 'ov2']);
  });

  it('stops at the time budget, skips remaining blocks, and says exactly what was skipped', async () => {
    // Injected clock: every now() call advances 4ms. Budget 10ms ⇒ the deadline
    // lands after block A's single comparison and before block B is reached.
    let t = 0;
    const now = (): number => {
      t += 4;
      return t;
    };
    const items: DedupItem[] = [
      item('a1', 'ka1', 1, { fuzzyText: 'the same document text v1', blockKey: 'blockA' }),
      item('a2', 'ka2', 2, { fuzzyText: 'the same document text v2', blockKey: 'blockA' }),
      item('b1', 'kb1', 3, { fuzzyText: 'first unrelated candidate', blockKey: 'blockB' }),
      item('b2', 'kb2', 4, { fuzzyText: 'second different candidate', blockKey: 'blockB' }),
      item('b3', 'kb3', 5, { fuzzyText: 'third distinct candidate', blockKey: 'blockB' }),
    ];
    const { groups, scan } = await findDuplicateGroups(items, {
      fuzzy: true,
      timeBudgetMs: 10,
      now,
    });
    // Block A was scanned and its near pair found before the budget expired.
    const near = groups.filter((g) => g.kind === 'near');
    expect(near).toHaveLength(1);
    expect(near[0]?.ids).toEqual(['a1', 'a2']);
    // Block B was skipped — and the result SAYS so.
    expect(scan.complete).toBe(false);
    expect(scan.reason).toBe('time_budget');
    expect(scan.pairsCompared).toBe(1);
    expect(scan.pairsSkipped).toBe(3); // 3·2/2 pairs in block B
    expect(scan.blocksTruncated).toBe(1);
    expect(scan.rowsInTruncatedBlocks).toBe(3);
  });

  it('yields to the event loop at the configured comparison interval', async () => {
    let yields = 0;
    const onYield = (): Promise<void> => {
      yields++;
      return Promise.resolve();
    };
    const items: DedupItem[] = [];
    for (let i = 0; i < 25; i++) {
      items.push(
        item(`y${String(i).padStart(2, '0')}`, `yk${String(i)}`, i, {
          fuzzyText: `yield probe text number ${i.toString(36).repeat(4)}`,
          blockKey: 'B',
        }),
      );
    }
    const { scan } = await findDuplicateGroups(items, {
      fuzzy: true,
      yieldEvery: 50,
      onYield,
    });
    expect(scan.complete).toBe(true);
    expect(scan.pairsCompared).toBe(300); // 25·24/2
    expect(yields).toBe(6); // one yield per 50 comparisons
  });

  it('never compares items in different candidate blocks', async () => {
    const items: DedupItem[] = [
      item('x1', 'kx1', 1, { fuzzyText: 'exactly the same text', blockKey: 'p' }),
      item('x2', 'kx2', 2, { fuzzyText: 'exactly the same text', blockKey: 'q' }),
    ];
    const { groups, scan } = await findDuplicateGroups(items, { fuzzy: true });
    expect(groups).toHaveLength(0);
    expect(scan.pairsCompared).toBe(0);
    expect(scan.complete).toBe(true);
  });

  it('caps comparison text: texts identical through the cap group at score 1', async () => {
    const base = 'lorem '.repeat(60); // 360 chars — well past the cap
    expect(base.length).toBeGreaterThan(MAX_FUZZY_TEXT_CHARS);
    const items: DedupItem[] = [
      item('c1', 'kc1', 1, { fuzzyText: base + 'ending one' }),
      item('c2', 'kc2', 2, { fuzzyText: base + 'completely different ending two' }),
    ];
    const { groups, scan } = await findDuplicateGroups(items, { fuzzy: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.score).toBe(1);
    expect(scan.pairsCompared).toBe(0); // identical capped texts resolve by identity
  });

  it('a capped scan is deterministic regardless of input order', async () => {
    const build = (): DedupItem[] => {
      const out: DedupItem[] = [];
      for (let i = 0; i < 30; i++) {
        out.push(
          item(`d${String(i).padStart(2, '0')}`, `dk${String(i)}`, i, {
            fuzzyText: 'sameprefix16char-' + i.toString(36).repeat(5),
            blockKey: 'B',
          }),
        );
      }
      return out;
    };
    const opts = { fuzzy: true, threshold: 0.95, maxPairsPerBlock: 100 };
    const first: DedupScanResult = await findDuplicateGroups(build(), opts);
    const second: DedupScanResult = await findDuplicateGroups(build().reverse(), opts);
    expect(second).toEqual(first);
  });

  it('exact groups are never truncated, even when the fuzzy budget is already spent', async () => {
    let calls = 0;
    const now = (): number => (calls++ === 0 ? 0 : 1000);
    const items: DedupItem[] = [
      item('e1', 'dup', 1),
      item('e2', 'dup', 2),
      item('e3', 'dup', 3),
      item('n1', 'kn1', 4, { fuzzyText: 'candidate document one', blockKey: 'B' }),
      item('n2', 'kn2', 5, { fuzzyText: 'candidate document two', blockKey: 'B' }),
    ];
    const { groups, scan } = await findDuplicateGroups(items, {
      fuzzy: true,
      timeBudgetMs: 1,
      now,
    });
    const exact = groups.filter((g) => g.kind === 'exact');
    expect(exact).toHaveLength(1);
    expect(exact[0]?.ids).toEqual(['e1', 'e2', 'e3']);
    expect(scan.complete).toBe(false);
    expect(scan.reason).toBe('time_budget');
    expect(scan.pairsSkipped).toBe(1);
    expect(scan.rowsInTruncatedBlocks).toBe(2);
  });
});
