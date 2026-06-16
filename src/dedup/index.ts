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
 */
import { bigramDice, DEFAULT_NEAR_THRESHOLD } from './match.js';

/** A row reduced to the fields grouping needs. `key` is already normalized. */
export interface DedupItem {
  id: string;
  key: string;
  createdAt?: string | null;
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

export interface FindGroupsOptions {
  /** Also surface fuzzy near-duplicate groups among rows that aren't exact dups. */
  fuzzy?: boolean;
  /** Near-duplicate similarity threshold (Sørensen–Dice over bigrams). */
  threshold?: number;
  /**
   * Blocking prefix length for fuzzy candidate generation — only rows whose key
   * shares the first N chars are compared pairwise, keeping fuzzy off the O(n²)
   * path on large tables. Rows with shorter keys fall into a shared short bucket.
   */
  blockPrefix?: number;
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

/**
 * Fuzzy near-duplicate groups among items not already in an exact group. Blocks
 * by key prefix, runs pairwise Dice only within a block, and unions pairs at/above
 * the threshold into connected components.
 */
function groupNear(
  items: DedupItem[],
  groupedIds: Set<string>,
  threshold: number,
  blockPrefix: number,
): DedupGroup[] {
  const pool = items.filter((it) => it.key && !groupedIds.has(it.id));
  if (pool.length < 2) return [];

  // Block by normalized-key prefix so we only compare plausibly-similar rows.
  const blocks = new Map<string, DedupItem[]>();
  for (const it of pool) {
    const block = it.key.slice(0, blockPrefix);
    const list = blocks.get(block);
    if (list) list.push(it);
    else blocks.set(block, [it]);
  }

  const uf = new UnionFind();
  const edges: { a: string; b: string; score: number }[] = [];

  for (const list of blocks.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!a || !b) continue;
        const score = bigramDice(a.key, b.key);
        if (score >= threshold) {
          edges.push({ a: a.id, b: b.id, score });
          uf.union(a.id, b.id);
        }
      }
    }
  }

  // Lowest qualifying edge weight per FINAL component root — a displayable score
  // computed after all unions so it isn't keyed on a stale intermediate root.
  const edgeMin = new Map<string, number>();
  for (const e of edges) {
    const root = uf.find(e.a);
    const prev = edgeMin.get(root);
    edgeMin.set(root, prev === undefined ? e.score : Math.min(prev, e.score));
  }

  // Collect connected components of size ≥ 2.
  const comps = new Map<string, DedupItem[]>();
  for (const it of pool) {
    const root = uf.find(it.id);
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
      score: edgeMin.get(root) ?? threshold,
      ids: list.map((it) => it.id),
    });
  }
  // Strongest (highest min-similarity) first.
  groups.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return groups;
}

/**
 * Find duplicate groups among items. Exact groups first; then, when `fuzzy` is
 * set, near-duplicate groups among the rows that weren't exact dups.
 */
export function findDuplicateGroups(
  items: DedupItem[],
  opts: FindGroupsOptions = {},
): DedupGroup[] {
  const { groups: exact, groupedIds } = groupExact(items);
  if (!opts.fuzzy) return exact;
  const near = groupNear(
    items,
    groupedIds,
    opts.threshold ?? DEFAULT_NEAR_THRESHOLD,
    Math.max(1, opts.blockPrefix ?? 4),
  );
  return [...exact, ...near];
}
