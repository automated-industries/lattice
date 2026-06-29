import type { Lattice } from '../lattice.js';
import type { AggregateResult, Row } from '../types.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { getConnector } from '../connectors/registry.js';
import { tableJunctions } from './data.js';
import { LINEAGE_TABLE } from './lineage-store.js';

/**
 * Data-provenance / lineage graph for an object table (or a single row).
 *
 * Surfaces, for any object, WHERE its data came from across three tiers — `raw`
 * (uploaded files, connectors, future SQL-warehouse sources), `computed`
 * (Lattice-created artifacts, imports, calculations), and `observation`
 * (AI / learning-loop edits). Computed from four substrates that already exist
 * (or are added additively by this feature):
 *   1. connector-stamped rows (`_source_connector_id` — set by connectors/sync)
 *   2. the additive `__lattice_lineage` table (file-extraction / import edges)
 *   3. audit rows authored by the `ai` actor (`_lattice_gui_audit.source='ai'`)
 *   4. existing `files` many-to-many junctions (raw file sources already linked,
 *      even when no lineage row was ever recorded — e.g. pre-existing data)
 *
 * Bounded reads: no `SELECT *` over a data table on this path. Counts
 * are computed in the database via grouped `aggregate(...)`; the only row reads
 * are bounded by `limit` (the small lineage table) or a single-row PK lookup.
 *
 * The vocabulary is deliberately generic (object / raw / computed / observation)
 * — there is no domain coupling to any particular dataset.
 */

export type ProvenanceNodeType = 'object' | 'raw' | 'computed' | 'observation';

export interface ProvenanceNode {
  id: string;
  label: string;
  /** `object` = the viewed table/row (graph center); others are source tiers. */
  type: ProvenanceNodeType;
  /** Free-text: file | connector | import | artifact | observation | table. */
  kind: string;
  /** Backing table, when the node maps to one (the object, or a source table). */
  table?: string;
  /** Backing row id, when the node is a single row. */
  rowId?: string;
  /** Count of object rows this source contributed (grouped source nodes). */
  count?: number;
}

export interface ProvenanceEdge {
  id: string;
  /** Node id of the upstream SOURCE. */
  source: string;
  /** Node id of the downstream OBJECT (the center). */
  target: string;
  /** synced_from | extracted_from | derived_from | materialized_from | observed_by */
  relation: string;
  label: string;
}

export interface ProvenancePayload {
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

export interface BuildProvenanceOptions {
  /** Scope to a single object row (bounded reads). Omit for the whole table. */
  rowId?: string;
  /**
   * GUI config paths. When provided, raw file sources are derived from the
   * existing `*_files` junctions (so provenance reflects files already linked to
   * an object, not only future import/extraction lineage). The junction rows are
   * read through the normal RLS-filtered query path, so a scoped cloud member
   * only ever sees links for rows it may see; if no `*_files` relation is
   * declared in the config, the derivation is a no-op (lineage only).
   */
  configPath?: string;
  outputDir?: string;
}

// ── dedupe helpers (mirror src/gui/data.ts addNode/addEdge) ──────────────────
function addNode(nodes: Map<string, ProvenanceNode>, node: ProvenanceNode): void {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, node);
  } else if (node.count !== undefined) {
    existing.count = (existing.count ?? 0) + node.count;
  }
}

function addEdge(edges: Map<string, ProvenanceEdge>, edge: Omit<ProvenanceEdge, 'id'>): void {
  const id = `${edge.source}->${edge.target}:${edge.relation}`;
  if (!edges.has(id)) edges.set(id, { ...edge, id });
}

/** Human label for a source. */
export function labelForSource(kind: string, name?: string): string {
  const named = (base: string): string => (name ? `${base}: ${name}` : base);
  switch (kind) {
    case 'file':
      return named('File');
    case 'connector':
      return named('Connector');
    case 'import':
      return named('Import');
    case 'artifact':
      return named('Artifact');
    case 'observation':
      return named('AI');
    case 'table':
      return name ?? 'Table';
    case 'sql_source':
      return named('SQL source');
    case 'calculation':
      return named('Calculation');
    default:
      return name ? `${kind}: ${name}` : kind;
  }
}

/** Edge relation verb for a source kind. */
export function relFor(kind: string): string {
  switch (kind) {
    case 'connector':
      return 'synced_from';
    case 'file':
      return 'extracted_from';
    case 'artifact':
      return 'derived_from';
    case 'import':
      return 'materialized_from';
    case 'observation':
      return 'observed_by';
    case 'calculation':
      return 'computed_from';
    default:
      return 'derived_from';
  }
}

const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/**
 * Build the provenance payload for `table` (or a single row when `rowId` is set).
 */
export async function buildProvenanceGraph(
  db: Lattice,
  table: string,
  options: BuildProvenanceOptions = {},
): Promise<ProvenancePayload> {
  const nodes = new Map<string, ProvenanceNode>();
  const edges = new Map<string, ProvenanceEdge>();
  const rowId = options.rowId;
  const cols = db.getRegisteredColumns(table) ?? {};

  // The downstream OBJECT — the graph center.
  const objectId = rowId ? `obj:${table}:${rowId}` : `table:${table}`;
  addNode(nodes, {
    id: objectId,
    label: rowId ? `${table} #${rowId}` : table,
    type: 'object',
    kind: 'table',
    table,
    ...(rowId ? { rowId } : {}),
  });

  // ── RAW: connector lineage from `_source_connector_id` ──────────────────────
  if ('_source_connector_id' in cols) {
    if (rowId) {
      const pk = db.getPrimaryKey(table)[0] ?? 'id';
      const rows = await db.query(table, {
        projection: ['_source_connector_id'],
        filters: [{ col: pk, op: 'eq', val: rowId }],
        limit: 1,
      });
      const cid = rows[0] ? asStr(rows[0]._source_connector_id) : '';
      if (cid) await addConnectorNode(db, nodes, edges, objectId, cid, 1);
    } else {
      // Grouped COUNT in SQL — only the grouped rows transfer (bounded read).
      const groups = await db.aggregate(table, {
        groupBy: ['_source_connector_id'],
        aggregates: [{ fn: 'count', as: 'n' }],
        filters: [{ col: '_source_connector_id', op: 'isNotNull' }],
        orderBy: 'n',
        orderDir: 'desc',
        limit: 100,
      });
      for (const g of groups) {
        const cid = asStr(g._source_connector_id);
        if (cid) await addConnectorNode(db, nodes, edges, objectId, cid, Number(g.n) || 0);
      }
    }
  }

  // ── RAW: existing file→object links (the `files` many-to-many junctions) ─────
  // The lineage table only records NEW import/extraction edges; an object whose
  // files were attached earlier (or by a path that doesn't write lineage) would
  // otherwise report zero sources even though files clearly feed it. Derive the
  // raw "file" tier directly from the existing `*_files` junctions so provenance
  // reflects real file sources without a backfill. Node ids match a `file`
  // lineage row's scheme, so the two dedupe rather than double-count.
  if (options.configPath && options.outputDir) {
    let fileJuncs: { junction: string; selfFk: string; otherFk: string }[] = [];
    try {
      fileJuncs = tableJunctions(table, options.configPath, options.outputDir).filter(
        (j) => j.otherTable === 'files',
      );
    } catch {
      fileJuncs = [];
    }
    for (const j of fileJuncs) {
      if (rowId) {
        // The file ids linked to THIS row (bounded by an explicit limit).
        const links = await db.query(j.junction, {
          projection: [j.otherFk],
          filters: [{ col: j.selfFk, op: 'eq', val: rowId }],
          limit: 200,
        });
        const fileIds = [...new Set(links.map((l) => asStr(l[j.otherFk])).filter(Boolean))];
        if (fileIds.length === 0) continue;
        // Resolve all file names in ONE batched `IN` query (not one PK lookup per
        // file — that was an N+1 on the provenance read path).
        const nameById = new Map<string, string>();
        try {
          const fpk = db.getPrimaryKey('files')[0] ?? 'id';
          const frows = await db.query('files', {
            projection: [fpk, 'name'],
            filters: [{ col: fpk, op: 'in', val: fileIds }],
            limit: fileIds.length,
          });
          for (const fr of frows) {
            const nm = asStr(fr.name);
            if (nm) nameById.set(asStr(fr[fpk]), nm);
          }
        } catch {
          /* keep ids as labels */
        }
        for (const fileId of fileIds) {
          const name = nameById.get(fileId) ?? fileId;
          const id = `src:file:files:${fileId}`;
          addNode(nodes, {
            id,
            label: labelForSource('file', name),
            type: 'raw',
            kind: 'file',
            table: 'files',
            rowId: fileId,
          });
          addEdge(edges, {
            source: id,
            target: objectId,
            relation: 'extracted_from',
            label: name,
          });
        }
      } else {
        // Whole table: count the file links — a grouped COUNT, never the rows.
        const counted = await db.aggregate(j.junction, {
          aggregates: [{ fn: 'count', as: 'n' }],
          filters: [{ col: j.otherFk, op: 'isNotNull' }],
        });
        const n = Number(counted[0]?.n) || 0;
        if (n > 0) {
          const id = `src:file:files`;
          addNode(nodes, {
            id,
            label: labelForSource('file', 'files'),
            type: 'raw',
            kind: 'file',
            table: 'files',
            count: n,
          });
          addEdge(edges, {
            source: id,
            target: objectId,
            relation: 'extracted_from',
            label: 'files',
          });
        }
      }
    }
  }

  // ── RAW / COMPUTED / OBSERVATION: explicit `__lattice_lineage` rows ──────────
  // `__lattice_lineage` is an unregistered raw-DDL table → read it with raw SQL.
  // Tolerate its absence (no lineage written yet) or a missing grant (a scoped
  // cloud member): provenance is a best-effort enrichment, so degrade to no
  // lineage edges rather than failing the whole view. Full per-member lineage is
  // future work (see the multiplayer-cloud provenance note).
  if (rowId) {
    // Bounded by the (object_table, object_id) index + an explicit LIMIT.
    let lin: Row[] = [];
    try {
      lin = await allAsyncOrSync(
        db.adapter,
        `SELECT * FROM "${LINEAGE_TABLE}" WHERE "object_table" = ? AND "object_id" = ? LIMIT 500`,
        [table, rowId],
      );
    } catch {
      lin = [];
    }
    for (const l of lin) addLineageRow(nodes, edges, objectId, l);
  } else {
    // Whole table: group by (source_kind, source_table, tier, relation) — counts
    // only, never the rows themselves. The `object_id='*'` table-level sentinel
    // is folded in here (it isn't scoped to a single row).
    let groups: AggregateResult[] = [];
    try {
      groups = await allAsyncOrSync(
        db.adapter,
        `SELECT "source_kind", "source_table", "tier", "relation", COUNT(*) AS n
           FROM "${LINEAGE_TABLE}" WHERE "object_table" = ?
           GROUP BY "source_kind", "source_table", "tier", "relation"
           ORDER BY n DESC LIMIT 200`,
        [table],
      );
    } catch {
      groups = [];
    }
    for (const g of groups) {
      const kind = asStr(g.source_kind);
      const srcTable = asStr(g.source_table);
      const tier = (asStr(g.tier) || 'raw') as ProvenanceNodeType;
      const relation = asStr(g.relation) || relFor(kind);
      const id = `src:${kind}:${srcTable || kind}`;
      // The junction derivation above already emitted (and counted) the grouped
      // `files` node from the actual file→object links. addNode SUMS counts on a
      // repeated id, so re-adding the lineage `file` rows here would double-count
      // files that are both junction-linked AND lineage-recorded — skip them.
      if (kind === 'file' && nodes.has(id)) continue;
      addNode(nodes, {
        id,
        label: labelForSource(kind, srcTable || undefined),
        type: tier,
        kind,
        ...(srcTable ? { table: srcTable } : {}),
        count: Number(g.n) || 0,
      });
      addEdge(edges, { source: id, target: objectId, relation, label: srcTable || kind });
    }
  }

  // ── OBSERVATION: rows authored by the AI actor (audit source='ai') ──────────
  {
    const filters: { col: string; op: 'eq'; val: unknown }[] = [
      { col: 'source', op: 'eq', val: 'ai' },
      { col: 'table_name', op: 'eq', val: table },
    ];
    if (rowId) filters.push({ col: 'row_id', op: 'eq', val: rowId });
    // Grouped COUNT — never transfers before_json/after_json blobs.
    const ai = await db.aggregate('_lattice_gui_audit', {
      aggregates: [{ fn: 'count', as: 'n' }],
      filters,
    });
    const n = Number(ai[0]?.n) || 0;
    if (n > 0) {
      const id = 'src:observation:ai';
      addNode(nodes, {
        id,
        label: labelForSource('observation', 'learning loop'),
        type: 'observation',
        kind: 'observation',
        count: n,
      });
      addEdge(edges, { source: id, target: objectId, relation: 'observed_by', label: 'ai edits' });
    }
  }

  // ── prune dangling edges (mirror src/gui/data.ts) ──────────────────────────
  const present = new Set(nodes.keys());
  const liveEdges = [...edges.values()].filter(
    (e) => present.has(e.source) && present.has(e.target),
  );
  return { nodes: [...nodes.values()], edges: liveEdges };
}

// Resolve a connector id to a named RAW source node + edge (bounded PK lookup).
async function addConnectorNode(
  db: Lattice,
  nodes: Map<string, ProvenanceNode>,
  edges: Map<string, ProvenanceEdge>,
  objectId: string,
  connectorId: string,
  count: number,
): Promise<void> {
  // getConnector reads __lattice_connectors (no cloud-member grant) — tolerate a
  // permission error by falling back to the raw id as the label.
  let rec = null;
  try {
    rec = await getConnector(db, connectorId);
  } catch {
    rec = null;
  }
  const name = rec?.displayName ?? rec?.toolkit ?? connectorId;
  const id = `src:connector:${connectorId}`;
  addNode(nodes, {
    id,
    label: labelForSource('connector', name),
    type: 'raw',
    kind: 'connector',
    count,
  });
  addEdge(edges, { source: id, target: objectId, relation: 'synced_from', label: name });
}

function addLineageRow(
  nodes: Map<string, ProvenanceNode>,
  edges: Map<string, ProvenanceEdge>,
  objectId: string,
  l: Row,
): void {
  const kind = asStr(l.source_kind);
  const srcTable = asStr(l.source_table);
  const srcId = asStr(l.source_id);
  const tier = (asStr(l.tier) || 'raw') as ProvenanceNodeType;
  const relation = asStr(l.relation) || relFor(kind);
  const id = srcId ? `src:${kind}:${srcTable || kind}:${srcId}` : `src:${kind}:${srcTable || kind}`;
  addNode(nodes, {
    id,
    label: labelForSource(kind, srcTable || undefined),
    type: tier,
    kind,
    ...(srcTable ? { table: srcTable } : {}),
    ...(srcId ? { rowId: srcId } : {}),
  });
  addEdge(edges, { source: id, target: objectId, relation, label: srcTable || kind });
}
