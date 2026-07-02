/**
 * Graph-augmented retrieval.
 *
 * Pure similarity retrieval treats every row as an island. Real knowledge is
 * relational: a document cites another, a task blocks a task, a person belongs to
 * a team. A typed-edge graph over the rows lets retrieval be *relationship-aware*
 * — traverse from an anchor entity to its neighborhood, and boost results that
 * are graph-connected to the things you already care about.
 *
 * Edges live in one internal `__lattice_edges` table (GUI-hidden by prefix).
 * They can be added explicitly, or extracted with **zero LLM** from existing
 * foreign-key columns. Traversal is a **bounded BFS** with hard caps on depth and
 * visited-node count, so a dense or cyclic graph can never blow up memory.
 */

import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, allAsyncOrSync, introspectColumnsAsyncOrSync } from '../db/adapter.js';
import { assertSafeIdentifier } from '../schema/identifier.js';

const EDGES_TABLE = '__lattice_edges';

/** Absolute ceiling on traversal depth — a hard guard against runaway BFS. */
export const MAX_TRAVERSAL_DEPTH = 5;
/** Default ceiling on visited nodes per traversal. */
export const DEFAULT_MAX_NODES = 10_000;

export interface GraphNode {
  table: string;
  id: string;
}

export interface GraphEdge {
  srcTable: string;
  srcId: string;
  dstTable: string;
  dstId: string;
  /** Edge type/label (e.g. 'cites', 'blocks', 'member_of'). */
  type: string;
  /** Edge weight (default 1). Higher = stronger relationship. */
  weight?: number;
}

export type TraversalDirection = 'out' | 'in' | 'both';

export interface TraversalOptions {
  /** Max BFS depth (clamped to MAX_TRAVERSAL_DEPTH). Default 2. */
  maxDepth?: number;
  /** Follow out-edges, in-edges, or both. Default 'out'. */
  direction?: TraversalDirection;
  /** Restrict to these edge types. */
  edgeTypes?: string[];
  /** Stop after visiting this many nodes (cycle/blowup guard). Default 10000. */
  maxNodes?: number;
}

export interface TraversalNode {
  node: GraphNode;
  /** BFS depth from the start node (start = 0). */
  depth: number;
}

export interface GraphTraversalResult {
  start: GraphNode;
  nodes: TraversalNode[];
  edges: GraphEdge[];
  /** True if a cap (depth or node count) stopped the traversal early. */
  truncated: boolean;
}

const nodeKey = (table: string, id: string): string => JSON.stringify([table, id]);

/** Ensure the internal edges table exists (idempotent, GUI-hidden by prefix). */
export async function ensureEdgesTable(adapter: StorageAdapter): Promise<void> {
  await runAsyncOrSync(
    adapter,
    `CREATE TABLE IF NOT EXISTS "${EDGES_TABLE}" (
       "src_table" TEXT NOT NULL,
       "src_id"    TEXT NOT NULL,
       "dst_table" TEXT NOT NULL,
       "dst_id"    TEXT NOT NULL,
       "edge_type" TEXT NOT NULL,
       "weight"    REAL NOT NULL DEFAULT 1,
       PRIMARY KEY ("src_table","src_id","dst_table","dst_id","edge_type")
     )`,
  );
}

/** Add (upsert) one edge. */
export async function addEdge(adapter: StorageAdapter, edge: GraphEdge): Promise<void> {
  await ensureEdgesTable(adapter);
  await runAsyncOrSync(
    adapter,
    `INSERT INTO "${EDGES_TABLE}" ("src_table","src_id","dst_table","dst_id","edge_type","weight")
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT ("src_table","src_id","dst_table","dst_id","edge_type")
       DO UPDATE SET "weight" = excluded."weight"`,
    [edge.srcTable, edge.srcId, edge.dstTable, edge.dstId, edge.type, edge.weight ?? 1],
  );
}

/** Add many edges (each upserted). */
export async function addEdges(adapter: StorageAdapter, edges: GraphEdge[]): Promise<void> {
  await ensureEdgesTable(adapter);
  for (const e of edges) await addEdge(adapter, e);
}

/** Remove one edge (all matching types when `type` omitted). */
export async function removeEdge(
  adapter: StorageAdapter,
  edge: Omit<GraphEdge, 'weight' | 'type'> & { type?: string },
): Promise<void> {
  // Publicly exported and callable before any addEdge ever created the table —
  // ensure it exists so the raw DELETE can't throw "no such table" on a fresh DB.
  await ensureEdgesTable(adapter);
  const clauses = ['"src_table" = ?', '"src_id" = ?', '"dst_table" = ?', '"dst_id" = ?'];
  const params: unknown[] = [edge.srcTable, edge.srcId, edge.dstTable, edge.dstId];
  if (edge.type !== undefined) {
    clauses.push('"edge_type" = ?');
    params.push(edge.type);
  }
  await runAsyncOrSync(
    adapter,
    `DELETE FROM "${EDGES_TABLE}" WHERE ${clauses.join(' AND ')}`,
    params,
  );
}

function rowToEdge(r: Record<string, unknown>): GraphEdge {
  return {
    srcTable: r.src_table as string,
    srcId: r.src_id as string,
    dstTable: r.dst_table as string,
    dstId: r.dst_id as string,
    type: r.edge_type as string,
    weight: Number(r.weight ?? 1),
  };
}

/** Direct neighbors of a node (one hop), in the given direction + type filter. */
export async function neighbors(
  adapter: StorageAdapter,
  node: GraphNode,
  opts: { direction?: TraversalDirection; edgeTypes?: string[] } = {},
): Promise<GraphEdge[]> {
  const direction = opts.direction ?? 'out';
  const typeFilter =
    opts.edgeTypes && opts.edgeTypes.length > 0
      ? ` AND "edge_type" IN (${opts.edgeTypes.map(() => '?').join(', ')})`
      : '';
  const typeParams = opts.edgeTypes ?? [];
  const out: GraphEdge[] = [];

  try {
    if (direction === 'out' || direction === 'both') {
      const rows = await allAsyncOrSync(
        adapter,
        `SELECT * FROM "${EDGES_TABLE}" WHERE "src_table" = ? AND "src_id" = ?${typeFilter}`,
        [node.table, node.id, ...typeParams],
      );
      out.push(...rows.map(rowToEdge));
    }
    if (direction === 'in' || direction === 'both') {
      const rows = await allAsyncOrSync(
        adapter,
        `SELECT * FROM "${EDGES_TABLE}" WHERE "dst_table" = ? AND "dst_id" = ?${typeFilter}`,
        [node.table, node.id, ...typeParams],
      );
      out.push(...rows.map(rowToEdge));
    }
  } catch {
    // No edges table yet → no neighbors.
    return [];
  }
  return out;
}

/**
 * Bounded breadth-first traversal from `start`. Hard caps: depth is clamped to
 * {@link MAX_TRAVERSAL_DEPTH}, and the visited set is capped at `maxNodes`. A
 * visited set prevents revisiting nodes in cyclic graphs.
 */
export async function traverse(
  adapter: StorageAdapter,
  start: GraphNode,
  opts: TraversalOptions = {},
): Promise<GraphTraversalResult> {
  const maxDepth = Math.min(MAX_TRAVERSAL_DEPTH, Math.max(0, opts.maxDepth ?? 2));
  const maxNodes = Math.max(1, opts.maxNodes ?? DEFAULT_MAX_NODES);
  const direction = opts.direction ?? 'out';

  const visited = new Map<string, TraversalNode>();
  const collectedEdges: GraphEdge[] = [];
  const startKey = nodeKey(start.table, start.id);
  visited.set(startKey, { node: start, depth: 0 });
  let frontier: GraphNode[] = [start];
  let truncated = false;

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      const edges = await neighbors(adapter, node, {
        direction,
        ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
      });
      for (const e of edges) {
        collectedEdges.push(e);
        // The "other end" relative to this node + direction.
        const isOut = e.srcTable === node.table && e.srcId === node.id;
        const other: GraphNode = isOut
          ? { table: e.dstTable, id: e.dstId }
          : { table: e.srcTable, id: e.srcId };
        const key = nodeKey(other.table, other.id);
        if (!visited.has(key)) {
          if (visited.size >= maxNodes) {
            truncated = true;
            break;
          }
          visited.set(key, { node: other, depth: depth + 1 });
          next.push(other);
        }
      }
      if (truncated) break;
    }
    if (truncated || next.length === 0) break;
    frontier = next;
  }

  return {
    start,
    nodes: [...visited.values()].sort((a, b) => a.depth - b.depth),
    edges: collectedEdges,
    truncated,
  };
}

export interface ExtractEdgesSpec {
  /** Source table holding the foreign key. */
  srcTable: string;
  /** FK column on the source table. */
  fkColumn: string;
  /** Table the FK points at. */
  dstTable: string;
  /** Edge type to label the extracted edges. Default `<fkColumn>`. */
  type?: string;
  /** Source-table primary key. Default 'id'. */
  pkColumn?: string;
}

/**
 * Zero-LLM edge extraction: derive `srcTable[pk] --type--> dstTable[fk]` edges
 * from a foreign-key column. Deterministic; no model. Returns the edge count.
 */
export async function extractEdgesFromColumn(
  adapter: StorageAdapter,
  spec: ExtractEdgesSpec,
): Promise<number> {
  await ensureEdgesTable(adapter);
  const pk = spec.pkColumn ?? 'id';
  const type = spec.type ?? spec.fkColumn;
  // srcTable / pk / fkColumn are interpolated into the SELECT below — grammar-guard
  // them so a hostile spec can't inject. (dstTable is stored as a bound value.)
  assertSafeIdentifier(spec.srcTable, 'table');
  assertSafeIdentifier(pk, 'column');
  assertSafeIdentifier(spec.fkColumn, 'column');
  let cols: string[] = [];
  try {
    cols = await introspectColumnsAsyncOrSync(adapter, spec.srcTable);
  } catch {
    cols = [];
  }
  const where = cols.includes('deleted_at') ? ` WHERE "deleted_at" IS NULL` : '';
  const rows = await allAsyncOrSync(
    adapter,
    `SELECT "${pk}" AS pk, "${spec.fkColumn}" AS fk FROM "${spec.srcTable}"${where}`,
  );
  let count = 0;
  for (const r of rows) {
    const srcId = scalarId(r.pk);
    const dstId = scalarId(r.fk);
    if (srcId === null || dstId === null) continue;
    await addEdge(adapter, {
      srcTable: spec.srcTable,
      srcId,
      dstTable: spec.dstTable,
      dstId,
      type,
    });
    count++;
  }
  return count;
}

/** Coerce a scalar id cell to a string, or null when it isn't a scalar. */
function scalarId(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

/**
 * Adjacency boost — re-score retrieval results by their graph connectivity to a
 * set of anchor nodes (e.g. the entities in the user's current context). A
 * result adjacent (within `maxDepth`) to an anchor is boosted by the edge weight
 * decayed by hop distance, scaled by `weight`. This makes retrieval
 * relationship-aware: things related to what you already care about rank higher.
 *
 * Returns a new array sorted by the boosted score; pure (no DB writes).
 */
export interface GraphBoostOptions {
  /** Anchor nodes whose neighborhood is preferred. */
  anchors: GraphNode[];
  /** Table the results belong to (results are `{ id, score }`). */
  resultTable: string;
  /** Boost weight applied to the adjacency signal. Default 0.5. */
  weight?: number;
  /** Hop radius from anchors to consider. Clamped to MAX_TRAVERSAL_DEPTH. Default 1. */
  maxDepth?: number;
  /** Edge direction from the anchor's perspective. Default 'both'. */
  direction?: TraversalDirection;
  edgeTypes?: string[];
}

export interface GraphBoostResult<T> {
  item: T;
  baseScore: number;
  boostedScore: number;
  /** Min hop distance to an anchor (Infinity if unreachable). */
  hops: number;
}

export async function graphAdjacencyBoost<T extends { id: string; score: number }>(
  adapter: StorageAdapter,
  results: T[],
  opts: GraphBoostOptions,
): Promise<GraphBoostResult<T>[]> {
  const weight = opts.weight ?? 0.5;
  const maxDepth = Math.min(MAX_TRAVERSAL_DEPTH, Math.max(1, opts.maxDepth ?? 1));
  // Build hop-distance from each anchor's neighborhood to result ids.
  const hopByResultId = new Map<string, number>();
  for (const anchor of opts.anchors) {
    const t = await traverse(adapter, anchor, {
      maxDepth,
      direction: opts.direction ?? 'both',
      ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
    });
    for (const tn of t.nodes) {
      if (tn.node.table !== opts.resultTable) continue;
      const prev = hopByResultId.get(tn.node.id);
      if (prev === undefined || tn.depth < prev) hopByResultId.set(tn.node.id, tn.depth);
    }
  }
  const out = results.map((item) => {
    const hops = hopByResultId.get(item.id);
    // depth 0 = the result is itself an anchor; treat it as 1 hop for boosting.
    const effectiveHops = hops === undefined ? Infinity : Math.max(1, hops);
    const boost = Number.isFinite(effectiveHops) ? weight / effectiveHops : 0;
    const boostedScore = item.score * (1 + boost);
    return {
      item: { ...item, score: boostedScore },
      baseScore: item.score,
      boostedScore,
      hops: effectiveHops,
    };
  });
  out.sort((a, b) => b.boostedScore - a.boostedScore);
  return out;
}
