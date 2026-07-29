/**
 * Generic duplicate-row grouping. Pure + dependency-free so it unit-tests without
 * a DB and runs identically on SQLite and Postgres workspaces. The caller (the
 * GUI dedup route) computes a normalized `key` per row — a column-set key for
 * ordinary tables, or a content hash for files — then this module buckets them
 * into exact groups and (optionally) fuzzy near-duplicate groups.
 *
 * It deliberately knows nothing about the schema, links, or mutations: it only
 * decides *which row ids belong together*. The route attaches labels, link
 * counts, and survivor logic afterwards.
 *
 * The fuzzy pass is BOUNDED. An unbounded pairwise scan once blocked the server's
 * only thread for minutes when every candidate landed in one block, so the scan
 * now (a) caps the comparison text length, (b) precomputes bigram profiles once
 * per candidate, (c) caps the pairs examined per candidate block, (d) runs under
 * an overall time budget, and (e) yields to the event loop between comparison
 * chunks. When any cap trips, the result SAYS SO — `scan.complete` goes false and
 * the stats name how much was not examined. A truncated scan is never presented
 * as a full one.
 */
import { bigramProfile, diceFromProfiles, DEFAULT_NEAR_THRESHOLD } from './match.js';
import type { BigramProfile } from './match.js';

/** A row reduced to the fields grouping needs. `key` is already normalized. */
export interface DedupItem {
  id: string;
  key: string;
  createdAt?: string | null;
  /**
   * Text the fuzzy comparison scores, when it should differ from `key` (e.g.
   * files strip their key-namespace tag and pass normalized content here).
   * Defaults to `key`. Capped at {@link MAX_FUZZY_TEXT_CHARS} regardless of
   * what the caller passes, so per-pair cost stays bounded.
   */
  fuzzyText?: string;
  /**
   * Candidate-block key for the fuzzy pass: only items sharing a block key are
   * ever compared. Defaults to a `blockPrefix`-length prefix of the comparison
   * text. Callers with structure (files: content prefix + length band) supply
   * their own so unrelated items never pair.
   */
  blockKey?: string;
}

export interface DedupGroup {
  kind: 'exact' | 'near';
  /** Representative key for the group (the shared key for exact; first member's for near). */
  key: string;
  /** For near groups, the lowest pairwise similarity that bound the group together. */
  score?: number;
  /** Member row ids, oldest first (by createdAt, then id). */
  ids: string[];
}

/** Honest accounting of how much of the fuzzy candidate space was examined. */
export interface DedupScanStats {
  /** True only when every candidate pair was either scored or resolved by text identity. */
  complete: boolean;
  /** Pairwise similarity comparisons actually scored. */
  pairsCompared: number;
  /** Candidate pairs NOT examined because a cap or the time budget tripped. */
  pairsSkipped: number;
  /** Candidate blocks whose pairwise scan was stopped early or never started. */
  blocksTruncated: number;
  /** Total rows sitting in those truncated blocks (rows that may hide unfound duplicates). */
  rowsInTruncatedBlocks: number;
  /** Why the scan is incomplete. Absent when complete. */
  reason?: 'time_budget' | 'pair_cap';
}

export interface DedupScanResult {
  groups: DedupGroup[];
  scan: DedupScanStats;
}

/**
 * Comparison-text cap for fuzzy scoring. Long documents are scored on their
 * first N normalized characters — enough signal to call two texts "nearly the
 * same" while keeping each comparison O(N) instead of O(document).
 */
export const MAX_FUZZY_TEXT_CHARS = 256;

/** Default per-block cap on scored pairs. 20k pairs ≈ tens of ms at capped text length. */
export const DEFAULT_MAX_PAIRS_PER_BLOCK = 20_000;

/** Default overall fuzzy-scan time budget. */
export const DEFAULT_TIME_BUDGET_MS = 2_000;

/** Default number of scored pairs between event-loop yields. */
export const DEFAULT_YIELD_EVERY = 2_048;

/**
 * When one block's candidate pairs exceed the per-block cap, the block is first
 * re-partitioned by this many leading comparison-text characters — one refinement
 * step that recovers most recall cheaply. Only if the members still share this
 * prefix does the hard pair cap apply.
 */
const SUB_BLOCK_PREFIX_CHARS = 16;

export interface FindGroupsOptions {
  /** Also surface fuzzy near-duplicate groups among rows that aren't exact dups. */
  fuzzy?: boolean;
  /** Near-duplicate similarity threshold (Sørensen–Dice over bigrams). */
  threshold?: number;
  /**
   * Blocking prefix length for fuzzy candidate generation when an item carries
   * no explicit `blockKey` — only rows whose comparison text shares the first N
   * chars are compared pairwise.
   */
  blockPrefix?: number;
  /** Cap on scored pairs per candidate block (default {@link DEFAULT_MAX_PAIRS_PER_BLOCK}). */
  maxPairsPerBlock?: number;
  /** Overall fuzzy-scan time budget in ms (default {@link DEFAULT_TIME_BUDGET_MS}). */
  timeBudgetMs?: number;
  /** Scored pairs between event-loop yields (default {@link DEFAULT_YIELD_EVERY}). */
  yieldEvery?: number;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
  /** Injectable yield for deterministic tests (default a 0ms timer — a real macrotask). */
  onYield?: () => Promise<void>;
}

/** Stable oldest-first sort: by createdAt ascending, then id, so survivor defaults are deterministic. */
function oldestFirst(a: DedupItem, b: DedupItem): number {
  const ca = a.createdAt ?? '';
  const cb = b.createdAt ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Exact-match groups: bucket by identical key, keep buckets with ≥ 2 rows. */
function groupExact(items: DedupItem[]): { groups: DedupGroup[]; groupedIds: Set<string> } {
  const buckets = new Map<string, DedupItem[]>();
  for (const it of items) {
    if (!it.key) continue; // empty key ⇒ not a duplicate of anything
    const list = buckets.get(it.key);
    if (list) list.push(it);
    else buckets.set(it.key, [it]);
  }
  const groups: DedupGroup[] = [];
  const groupedIds = new Set<string>();
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    list.sort(oldestFirst);
    list.forEach((it) => groupedIds.add(it.id));
    groups.push({ kind: 'exact', key, ids: list.map((it) => it.id) });
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups, groupedIds };
}

/** Minimal union-find for grouping near-duplicate pairs into connected components. */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** The comparison text for an item, capped so per-pair cost stays bounded. */
function comparisonText(it: DedupItem): string {
  return (it.fuzzyText ?? it.key).slice(0, MAX_FUZZY_TEXT_CHARS);
}

/** n·(n−1)/2 without intermediate overflow concerns at our scales. */
function pairCount(n: number): number {
  return (n * (n - 1)) / 2;
}

/** Mutable state threaded through the bounded fuzzy scan. */
interface ScanState {
  threshold: number;
  maxPairsPerBlock: number;
  yieldEvery: number;
  now: () => number;
  deadline: number;
  onYield: () => Promise<void>;
  sinceYield: number;
  pairsCompared: number;
  pairsSkipped: number;
  blocksTruncated: number;
  rowsInTruncatedBlocks: number;
  budgetHit: boolean;
  capHit: boolean;
  uf: UnionFind;
  edges: { a: string; b: string; score: number }[];
}

/**
 * Bucket a block's members by identical comparison text and resolve those
 * buckets for free: items with the same (capped) text are near-duplicates at
 * score 1 by definition, and scoring only one representative per distinct text
 * preserves the exact grouping a full pairwise pass would produce — Dice is a
 * pure function of the two texts, so every member of a bucket scores identically
 * against everything else. This collapses the degenerate "thousands of copies of
 * the same document" block from quadratic to linear.
 */
function collapseIdenticalTexts(
  members: DedupItem[],
  state: ScanState,
): { reps: DedupItem[]; repText: Map<string, string> } {
  const byText = new Map<string, DedupItem[]>();
  for (const m of members) {
    const t = comparisonText(m);
    const list = byText.get(t);
    if (list) list.push(m);
    else byText.set(t, [m]);
  }
  const reps: DedupItem[] = [];
  const repText = new Map<string, string>();
  for (const [text, bucket] of byText) {
    const head = bucket[0];
    if (!head) continue;
    reps.push(head);
    repText.set(head.id, text);
    if (bucket.length >= 2) {
      for (let i = 1; i < bucket.length; i++) {
        const other = bucket[i];
        if (!other) continue;
        state.uf.union(head.id, other.id);
      }
      const second = bucket[1];
      if (second) state.edges.push({ a: head.id, b: second.id, score: 1 });
    }
  }
  return { reps, repText };
}

/** Count a yield tick and yield to the event loop when the interval is reached. */
async function maybeYield(state: ScanState): Promise<void> {
  state.sinceYield++;
  if (state.sinceYield >= state.yieldEvery) {
    state.sinceYield = 0;
    await state.onYield();
  }
}

/**
 * Scan one candidate block (or sub-block). Identical texts are resolved first;
 * distinct texts are scored pairwise in deterministic (oldest-first) order under
 * the per-block pair cap and the overall time budget. `allowSplit` permits one
 * prefix-refinement re-partition before the hard cap applies.
 */
async function scanBlock(
  members: DedupItem[],
  state: ScanState,
  allowSplit: boolean,
): Promise<void> {
  if (members.length < 2) return;
  const { reps, repText } = collapseIdenticalTexts(members, state);
  const totalRepPairs = pairCount(reps.length);
  if (totalRepPairs === 0) return;

  if (totalRepPairs > state.maxPairsPerBlock && allowSplit) {
    // One refinement step: re-partition on a longer text prefix. If it actually
    // splits the block, each part is scanned (capped, no further splitting).
    const parts = new Map<string, DedupItem[]>();
    for (const m of members) {
      const sub = comparisonText(m).slice(0, SUB_BLOCK_PREFIX_CHARS);
      const list = parts.get(sub);
      if (list) list.push(m);
      else parts.set(sub, [m]);
    }
    if (parts.size > 1) {
      const keys = [...parts.keys()].sort();
      for (const k of keys) {
        const part = parts.get(k);
        if (part) await scanBlock(part, state, false);
      }
      return;
    }
  }

  // Profiles once per distinct text — never per pair.
  const profiles = new Map<string, BigramProfile>();
  for (const r of reps) profiles.set(r.id, bigramProfile(repText.get(r.id) ?? ''));

  let done = 0;
  let truncated = false;
  outer: for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      if (done >= state.maxPairsPerBlock) {
        state.capHit = true;
        truncated = true;
        break outer;
      }
      if (state.now() > state.deadline) {
        state.budgetHit = true;
        truncated = true;
        break outer;
      }
      const a = reps[i];
      const b = reps[j];
      if (!a || !b) continue;
      const pa = profiles.get(a.id);
      const pb = profiles.get(b.id);
      if (!pa || !pb) continue;
      const score = diceFromProfiles(pa, pb);
      done++;
      state.pairsCompared++;
      if (score >= state.threshold) {
        state.edges.push({ a: a.id, b: b.id, score });
        state.uf.union(a.id, b.id);
      }
      await maybeYield(state);
    }
  }
  if (truncated) {
    state.pairsSkipped += totalRepPairs - done;
    state.blocksTruncated++;
    state.rowsInTruncatedBlocks += members.length;
  }
}

/**
 * Account for a block the time budget prevented scanning at all. Identical-text
 * members are still resolved (a single linear pass), so exact-content copies are
 * never missed even when the budget is exhausted; the unscored representative
 * pairs are reported as skipped.
 */
function skipBlock(members: DedupItem[], state: ScanState): void {
  const { reps } = collapseIdenticalTexts(members, state);
  const remaining = pairCount(reps.length);
  if (remaining === 0) return;
  state.pairsSkipped += remaining;
  state.blocksTruncated++;
  state.rowsInTruncatedBlocks += members.length;
  state.budgetHit = true;
}

/**
 * Fuzzy near-duplicate groups among items not already in an exact group. Blocks
 * by `blockKey` (or a comparison-text prefix), resolves identical texts for
 * free, scores distinct texts pairwise within a block — bounded by the per-block
 * pair cap and the overall time budget, yielding to the event loop as it goes —
 * and unions pairs at/above the threshold into connected components.
 */
async function groupNearBounded(
  items: DedupItem[],
  groupedIds: Set<string>,
  opts: Required<Pick<FindGroupsOptions, 'threshold' | 'blockPrefix'>> &
    Pick<FindGroupsOptions, 'maxPairsPerBlock' | 'timeBudgetMs' | 'yieldEvery' | 'now' | 'onYield'>,
): Promise<{ groups: DedupGroup[]; scan: DedupScanStats }> {
  const pool = items.filter((it) => it.key && !groupedIds.has(it.id));
  // Oldest-first pool order makes pair order — and therefore WHICH pairs a
  // capped scan examines — deterministic for the same input.
  pool.sort(oldestFirst);

  const now = opts.now ?? Date.now;
  const state: ScanState = {
    threshold: opts.threshold,
    maxPairsPerBlock: Math.max(1, opts.maxPairsPerBlock ?? DEFAULT_MAX_PAIRS_PER_BLOCK),
    yieldEvery: Math.max(1, opts.yieldEvery ?? DEFAULT_YIELD_EVERY),
    now,
    deadline: now() + Math.max(1, opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS),
    onYield: opts.onYield ?? ((): Promise<void> => new Promise((r) => setTimeout(r, 0))),
    sinceYield: 0,
    pairsCompared: 0,
    pairsSkipped: 0,
    blocksTruncated: 0,
    rowsInTruncatedBlocks: 0,
    budgetHit: false,
    capHit: false,
    uf: new UnionFind(),
    edges: [],
  };

  if (pool.length >= 2) {
    // Block by explicit blockKey, else by comparison-text prefix.
    const blocks = new Map<string, DedupItem[]>();
    for (const it of pool) {
      const block = it.blockKey ?? comparisonText(it).slice(0, opts.blockPrefix);
      const list = blocks.get(block);
      if (list) list.push(it);
      else blocks.set(block, [it]);
    }
    const blockKeys = [...blocks.keys()].sort();
    for (const bk of blockKeys) {
      const members = blocks.get(bk);
      if (!members || members.length < 2) continue;
      if (state.now() > state.deadline) {
        skipBlock(members, state);
        continue;
      }
      await scanBlock(members, state, true);
    }
  }

  // Lowest qualifying edge weight per FINAL component root — a displayable score
  // computed after all unions so it isn't keyed on a stale intermediate root.
  const edgeMin = new Map<string, number>();
  for (const e of state.edges) {
    const root = state.uf.find(e.a);
    const prev = edgeMin.get(root);
    edgeMin.set(root, prev === undefined ? e.score : Math.min(prev, e.score));
  }

  // Collect connected components of size ≥ 2.
  const comps = new Map<string, DedupItem[]>();
  for (const it of pool) {
    const root = state.uf.find(it.id);
    const list = comps.get(root);
    if (list) list.push(it);
    else comps.set(root, [it]);
  }

  const groups: DedupGroup[] = [];
  for (const [root, list] of comps) {
    if (list.length < 2) continue;
    list.sort(oldestFirst);
    const head = list[0];
    if (!head) continue;
    groups.push({
      kind: 'near',
      key: head.key,
      score: edgeMin.get(root) ?? opts.threshold,
      ids: list.map((it) => it.id),
    });
  }
  // Strongest (highest min-similarity) first.
  groups.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const complete = !state.budgetHit && !state.capHit;
  const scan: DedupScanStats = {
    complete,
    pairsCompared: state.pairsCompared,
    pairsSkipped: state.pairsSkipped,
    blocksTruncated: state.blocksTruncated,
    rowsInTruncatedBlocks: state.rowsInTruncatedBlocks,
    ...(complete ? {} : { reason: state.budgetHit ? 'time_budget' : 'pair_cap' }),
  };
  return { groups, scan };
}

/**
 * Find duplicate groups among items. Exact groups first (always complete —
 * exact bucketing is linear and never truncated); then, when `fuzzy` is set, a
 * BOUNDED near-duplicate scan among the rows that weren't exact dups. The
 * returned `scan` says honestly whether every fuzzy candidate pair was examined;
 * callers surfacing "no duplicates found" must check `scan.complete` first.
 */
export async function findDuplicateGroups(
  items: DedupItem[],
  opts: FindGroupsOptions = {},
): Promise<DedupScanResult> {
  const { groups: exact, groupedIds } = groupExact(items);
  const completeScan: DedupScanStats = {
    complete: true,
    pairsCompared: 0,
    pairsSkipped: 0,
    blocksTruncated: 0,
    rowsInTruncatedBlocks: 0,
  };
  if (!opts.fuzzy) return { groups: exact, scan: completeScan };
  const near = await groupNearBounded(items, groupedIds, {
    threshold: opts.threshold ?? DEFAULT_NEAR_THRESHOLD,
    blockPrefix: Math.max(1, opts.blockPrefix ?? 4),
    ...(opts.maxPairsPerBlock !== undefined ? { maxPairsPerBlock: opts.maxPairsPerBlock } : {}),
    ...(opts.timeBudgetMs !== undefined ? { timeBudgetMs: opts.timeBudgetMs } : {}),
    ...(opts.yieldEvery !== undefined ? { yieldEvery: opts.yieldEvery } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.onYield !== undefined ? { onYield: opts.onYield } : {}),
  });
  return { groups: [...exact, ...near.groups], scan: near.scan };
}
