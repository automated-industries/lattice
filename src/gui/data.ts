import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseConfigFile, type ParsedConfig } from '../config/parser.js';
import { entityFileNames, readManifest, type LatticeManifest } from '../lifecycle/manifest.js';
import type { EntityFileSource, EnrichmentLookup } from '../schema/entity-context.js';
import { isInternalNativeEntity } from '../framework/native-entities.js';
import type { BelongsToRelation, Relation, TableDefinition } from '../types.js';

export interface GuiTableSummary {
  name: string;
  columns: string[];
  outputFile: string;
  relations: Record<string, Relation>;
  /** Human description of the entity, when declared in the config. */
  description?: string;
  /**
   * Populated by the server when serving /api/entities; absent on direct
   * data.ts use. `null` means the server couldn't determine a count for
   * this table (e.g. a never-analyzed table on the Postgres approximate-
   * count path) — the SPA renders these as "—".
   */
  rowCount?: number | null;
  /** True for framework-shipped native entities (files, secrets). Set by the server. */
  native?: boolean;
  /**
   * Connected data type only: the toolkit this table is synced from (e.g. `'jira'`).
   * Drives the "Connected" badge in the Objects list. Set by the server.
   */
  connectorToolkit?: string;
  /**
   * True for saved computed tables (live, read-only projections defined over
   * other tables). Drives the Tables explorer's "Computed Tables" tier. Set by
   * the server when the computed-tables engine stamps it.
   */
  computedTable?: boolean;
  /**
   * Provenance classification: 'source' = ingested/connected data; 'derived' =
   * materialized from ingested data (per the lineage store). Drives the Tables
   * explorer's Inputs/Derived split. Set by the server.
   */
  origin?: 'source' | 'derived';
  /** Team cloud only: this table is shared to the whole team. Set by the server. */
  shared?: boolean;
  /** Team cloud only: the operator owns this table. Set by the server. */
  ownedByMe?: boolean;
  /**
   * Team cloud only: the visibility newly-created rows in this shared table are
   * born with ('private' | 'everyone'). Drives the Data Model "new rows default
   * to" select (owner-only). Absent when the table isn't shared. Set by the server.
   */
  defaultRowVisibility?: 'private' | 'everyone';
  /**
   * Cloud (owner view) only: this table is marked never-shareable — the share/grant
   * functions refuse it and new rows are forced private (a Secrets/Messages-class
   * hard exclusion). Drives the Data Model "never share" indicator. Set by the server.
   */
  neverShare?: boolean;
  /**
   * Team cloud only: the shared table's schema_version, used as the
   * optimistic-concurrency token for data-model edits. Absent when the table
   * isn't shared (or on local). Set by the server.
   */
  schemaVersion?: number;
  /**
   * Column name → SQL type, for the Data Model schema cards. Set by the server
   * from the registered schema; absent for tables Lattice can't introspect.
   */
  columnTypes?: Record<string, string>;
  /**
   * Column name → canonical Lattice field type (text/integer/real/boolean/
   * uuid/datetime/date), for the Data Model column editor. Preferred over
   * `columnTypes` for display (the SQL spec is lossy and noisy). Present for
   * config-declared (YAML) tables; absent for code-defined tables with no
   * declared field types, where the editor falls back to `columnTypes`.
   */
  fieldTypes?: Record<string, string>;
}

export interface GuiFileSummary {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
}

export interface GuiEntitySummary {
  table: string;
  slug: string;
  directoryRoot: string;
  files: GuiFileSummary[];
  status: 'rendered' | 'missing-files';
}

export interface GuiProjectSummary {
  configPath: string;
  outputDir: string;
  dbName: string;
  tableCount: number;
  entityContextCount: number;
  manifestVersion: number | null;
  generatedAt: string | null;
}

export interface GuiEntitiesPayload {
  tables: GuiTableSummary[];
  entities: GuiEntitySummary[];
  hasManifest: boolean;
}

export interface GuiGraphNode {
  id: string;
  label: string;
  type: 'table' | 'entity' | 'file';
  table?: string;
  slug?: string;
  path?: string;
  status?: string;
}

export interface GuiGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'contains' | 'renders' | 'belongsTo' | 'hasMany' | 'manyToMany' | 'markdown' | 'computes';
  label: string;
}

export interface GuiGraphPayload {
  nodes: GuiGraphNode[];
  edges: GuiGraphEdge[];
  /** True when row/file detail nodes were capped (a large workspace). */
  truncated?: boolean;
  /** Total entity (row) count in the workspace, before capping. */
  totalEntities?: number;
}

interface GuiData {
  parsed: ParsedConfig;
  manifest: LatticeManifest | null;
  project: GuiProjectSummary;
  entities: GuiEntitySummary[];
  tables: GuiTableSummary[];
}

export function tableToSummary(name: string, definition: TableDefinition): GuiTableSummary {
  return {
    name,
    columns: Object.keys(definition.columns),
    outputFile: definition.outputFile ?? `.schema-only/${name}.md`,
    relations: definition.relations ?? {},
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.fieldTypes ? { fieldTypes: definition.fieldTypes } : {}),
  };
}

/**
 * Map of entity name → human description, for entities that declare one.
 * Fed to the ingest classifier so it can reason about what each entity is.
 */
export function entityDescriptions(configPath: string, outputDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of getGuiEntities(configPath, outputDir).tables) {
    if (t.description) out[t.name] = t.description;
  }
  return out;
}

function safeResolveInside(baseDir: string, requestedPath: string): string {
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(baseDir, requestedPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new Error(`Path escapes output directory: ${requestedPath}`);
  }
  return resolved;
}

function fileSummary(outputDir: string, relPath: string): GuiFileSummary {
  const absPath = safeResolveInside(outputDir, relPath);
  let bytes = 0;
  const exists = existsSync(absPath);
  if (exists) {
    bytes = readFileSync(absPath).byteLength;
  }
  return { name: basename(relPath), path: relPath, exists, bytes };
}

function collectEntities(outputDir: string, manifest: LatticeManifest | null): GuiEntitySummary[] {
  if (!manifest) return [];
  const result: GuiEntitySummary[] = [];

  for (const [table, entry] of Object.entries(manifest.entityContexts)) {
    for (const [slug, fileEntry] of Object.entries(entry.entities)) {
      const files = entityFileNames(fileEntry).map((filename) =>
        // POSIX-joined: this relative path is a logical id surfaced to the
        // browser (graph node ids, /context paths) and must not vary by OS.
        fileSummary(outputDir, [entry.directoryRoot, slug, filename].join('/')),
      );
      result.push({
        table,
        slug,
        directoryRoot: entry.directoryRoot,
        files,
        status: files.every((f) => f.exists) ? 'rendered' : 'missing-files',
      });
    }
  }

  return result.sort((a, b) => `${a.table}/${a.slug}`.localeCompare(`${b.table}/${b.slug}`));
}

/**
 * Single-entry, mtime-keyed cache of the parsed workspace config. `GET
 * /api/entities` (via {@link loadGuiData}) re-parses the YAML on every call, so
 * during a bulk op + its activity-feed refetches the same file was parsed
 * dozens of times. A config write bumps the file mtime, so writers
 * self-invalidate; a workspace switch changes the path, also a miss. The parsed
 * result is treated as read-only (config is never mutated by consumers).
 */
let _parsedCache: { path: string; key: string; parsed: ParsedConfig } | null = null;

function parseConfigCached(configPath: string): ParsedConfig {
  let key: string;
  try {
    const st = statSync(configPath);
    // mtime + size: a config edit changes the size (a new entity block) or the
    // mtime (a rewrite), so even a sub-millisecond mtime collision still misses.
    key = `${String(st.mtimeMs)}:${String(st.size)}`;
  } catch {
    return parseConfigFile(configPath); // stat failed — parse directly, don't cache
  }
  if (_parsedCache?.path === configPath && _parsedCache.key === key) {
    return _parsedCache.parsed;
  }
  const parsed = parseConfigFile(configPath);
  _parsedCache = { path: configPath, key, parsed };
  return parsed;
}

export function loadGuiData(
  configPath: string,
  outputDir: string,
  includeEntities = true,
): GuiData {
  const parsed = parseConfigCached(configPath);
  const manifest = readManifest(outputDir);
  const tables = parsed.tables.map(({ name, definition }) => tableToSummary(name, definition));
  // The rendered-file scan (collectEntities) is O(files) on disk — only the full
  // brain-graph detail-node path consumes it. The Objects list / Tables / the
  // schema-only graph use just `tables`, so hot-path callers pass
  // includeEntities=false to skip the scan and stay fast on a large workspace.
  const entities = includeEntities ? collectEntities(outputDir, manifest) : [];

  return {
    parsed,
    manifest,
    tables,
    entities,
    project: {
      configPath: resolve(configPath),
      outputDir: resolve(outputDir),
      dbName: basename(parsed.dbPath),
      tableCount: tables.length,
      entityContextCount: parsed.entityContexts.length,
      manifestVersion: manifest?.version ?? null,
      generatedAt: manifest?.generated_at ?? null,
    },
  };
}

function sourceTargets(
  source: EntityFileSource | EnrichmentLookup,
): { table: string; type: GuiGraphEdge['type']; label: string }[] {
  switch (source.type) {
    case 'self':
    case 'custom':
      return [];
    case 'hasMany':
      return [{ table: source.table, type: 'hasMany', label: source.foreignKey }];
    case 'belongsTo':
      return [{ table: source.table, type: 'belongsTo', label: source.foreignKey }];
    case 'manyToMany':
      return [
        { table: source.junctionTable, type: 'manyToMany', label: source.localKey },
        { table: source.remoteTable, type: 'manyToMany', label: source.remoteKey },
      ];
    case 'enriched':
      return Object.values(source.include).flatMap((lookup) => sourceTargets(lookup));
  }
}

function addNode(nodes: Map<string, GuiGraphNode>, node: GuiGraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, GuiGraphEdge>, edge: Omit<GuiGraphEdge, 'id'>): void {
  const id = `${edge.source}->${edge.target}:${edge.type}:${edge.label}`;
  if (!edges.has(id)) edges.set(id, { ...edge, id });
}

function markdownLinks(content: string): string[] {
  const links = new Set<string>();
  const mdLinkRe = /\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLinkRe.exec(content)) !== null) {
    const href = match[1];
    if (!href || href.startsWith('http:') || href.startsWith('https:') || href.startsWith('#')) {
      continue;
    }
    links.add(href.split('#')[0] ?? href);
  }
  return [...links];
}

function normalizeObjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function objectNameKeys(value: string): string[] {
  const normalized = normalizeObjectName(value);
  const keys = new Set([normalized]);
  if (normalized.endsWith('s')) keys.add(normalized.slice(0, -1));
  if (normalized.endsWith('ies')) keys.add(`${normalized.slice(0, -3)}y`);
  return [...keys].filter(Boolean);
}

export interface BuildGuiGraphOptions {
  /**
   * Tables registered on the live Lattice that the YAML doesn't declare
   * — native entities (files/secrets) and team-shared tables. Added as
   * graph nodes so the Data Model view shows them. Deduped by name
   * against the YAML tables.
   */
  extraTables?: GuiTableSummary[];
  /**
   * Team-cloud visibility predicate. When provided, `table`-type nodes
   * whose name fails the predicate are dropped (and any edge touching a
   * dropped node is pruned). Used to hide tables the operator neither
   * owns nor has shared to them.
   */
  visibleFilter?: (tableName: string) => boolean;
  /**
   * Cap on the total row/file ("detail") nodes drawn over the always-present
   * table topology. A force-directed graph can't render tens of thousands of
   * nodes (a large cloud), so detail nodes are bounded; the table+relationship
   * schema always renders in full. Default 1200.
   */
  maxDetailNodes?: number;
  /** Per-table cap on row nodes, so one huge table can't consume the whole budget. Default 50. */
  maxEntityNodesPerTable?: number;
  /**
   * Schema-only: emit the table topology (one node per table + relationship edges)
   * with NO row/file detail nodes at all. The GUI's force graph is a data MODEL
   * view — it only ever draws table nodes — so this skips generating the detail
   * nodes it would otherwise discard, keeping the payload tiny + scalable no matter
   * how many rows the workspace holds.
   */
  schemaOnly?: boolean;
}

/**
 * Tables that are first-class entities everywhere else (the Objects list,
 * /api/entities, the Sources tree) but are intentionally OMITTED from the brain
 * graph. `files` is referenced by so many objects that it renders as a dense hub
 * that dominates the layout and drowns out the actual object↔object
 * relationships — and a file is a SOURCE, not an object. The Files sidebar is the
 * canonical entry point for files. This changes the /api/graph payload CONTENT
 * (fewer nodes/edges), never its SHAPE — no API-contract change for consumers.
 */
const GRAPH_HIDDEN_TABLES = new Set<string>(['files']);

export function buildGuiGraph(
  configPath: string,
  outputDir: string,
  options: BuildGuiGraphOptions = {},
): GuiGraphPayload {
  // Schema-only (the GUI's only graph mode) never draws row/file detail nodes, so
  // it doesn't need the O(files) rendered-file scan — skip it. Markdown edges below
  // still come from the (cheap) manifest, and `data.entities` is unused on this path.
  const data = loadGuiData(configPath, outputDir, !options.schemaOnly);
  // Merge in runtime-registered tables (natives, team-shared) the YAML
  // doesn't carry, so the Data Model graph isn't empty for cloud DBs.
  if (options.extraTables && options.extraTables.length > 0) {
    const seen = new Set(data.tables.map((t) => t.name));
    for (const extra of options.extraTables) {
      if (!seen.has(extra.name)) {
        data.tables.push(extra);
        seen.add(extra.name);
      }
    }
  }
  // Apply the team-cloud visibility filter to the table set up front so
  // nodes, edges, and the junction synthesis below all operate on the
  // visible subset only.
  if (options.visibleFilter) {
    const filter = options.visibleFilter;
    data.tables = data.tables.filter((t) => filter(t.name));
  }
  // Internal native entities (chat_threads/chat_messages) back the assistant's
  // conversation storage. They're real tables but must never surface as nodes in
  // the Data Model graph — mirrors the Objects-list filter in entitiesWithCounts
  // (server.ts) so the visualization and the sidebar agree on what's user-facing.
  data.tables = data.tables.filter(
    (t) => !isInternalNativeEntity(t.name) && !GRAPH_HIDDEN_TABLES.has(t.name),
  );
  const nodes = new Map<string, GuiGraphNode>();
  const edges = new Map<string, GuiGraphEdge>();
  const fileOwners = new Map<string, GuiEntitySummary>();
  for (const entity of data.entities) {
    for (const file of entity.files) {
      fileOwners.set(`file:${file.path}`, entity);
    }
  }
  const knownFileIds = new Set(fileOwners.keys());

  // Junction tables are hidden as nodes ("just the main objects") — they
  // surface only as the many-to-many edge between the two objects they link.
  // Filtering here (server-side) means the payload never contains a junction
  // node, so the chart can't flash a junction box before a client-side filter
  // catches up.
  const junctionTableNames = new Set(data.tables.filter(isJunctionTable).map((t) => t.name));

  for (const table of data.tables) {
    if (junctionTableNames.has(table.name)) continue;
    const tableId = `table:${table.name}`;
    addNode(nodes, { id: tableId, label: table.name, type: 'table', table: table.name });
    for (const [relationName, relation] of Object.entries(table.relations)) {
      // Don't draw an edge into a hidden junction node.
      if (junctionTableNames.has(relation.table)) continue;
      addEdge(edges, {
        source: tableId,
        target: `table:${relation.table}`,
        type: relation.type,
        label: relationName,
      });
    }
  }

  // Synthesize the many-to-many edge each junction represents, between its two
  // belongsTo targets (the objects on either side of the join).
  for (const junction of data.tables.filter(isJunctionTable)) {
    const [left, right] = Object.values(junction.relations)
      .filter((r) => r.type === 'belongsTo')
      .map((r) => r.table);
    if (left && right) {
      addEdge(edges, {
        source: `table:${left}`,
        target: `table:${right}`,
        type: 'manyToMany',
        label: junction.name,
      });
    }
  }

  // Computed tables: one `computes` edge per definition, base table → computed
  // view. The definitions come from the parsed config (the same source the
  // entity tables use); the computed table's node normally arrives via
  // options.extraTables (computed views live in the runtime registry, not in
  // `entities:`), but it is added here too so the edge is never dangling for a
  // caller that passed no extras. A hidden/filtered base prunes the edge via
  // the referential-consistency filters below.
  for (const { name, definition } of data.parsed.computedTables) {
    if (options.visibleFilter && !options.visibleFilter(name)) continue;
    addNode(nodes, { id: `table:${name}`, label: name, type: 'table', table: name });
    addEdge(edges, {
      source: `table:${definition.base}`,
      target: `table:${name}`,
      type: 'computes',
      label: 'computed',
    });
  }

  const objectLookup = new Map<string, string>();
  for (const table of data.tables) {
    for (const key of objectNameKeys(table.name)) objectLookup.set(key, table.name);
  }
  for (const [table, entry] of Object.entries(data.manifest?.entityContexts ?? {})) {
    for (const key of objectNameKeys(entry.directoryRoot)) objectLookup.set(key, table);
  }
  for (const [table, entry] of Object.entries(data.manifest?.entityContexts ?? {})) {
    for (const filename of entry.declaredFiles) {
      for (const key of objectNameKeys(filename)) {
        const targetTable = objectLookup.get(key);
        if (targetTable && targetTable !== table) {
          addEdge(edges, {
            source: `table:${table}`,
            target: `table:${targetTable}`,
            type: 'markdown',
            label: filename,
          });
          break;
        }
      }
    }
  }

  // Schema-only (the GUI's data-model graph): return the table topology with no
  // row/file detail nodes — tiny payload, scales to any row count. Filter edges
  // for referential consistency, same as the full path below.
  if (options.schemaOnly) {
    const tableNodeIds = new Set(nodes.keys());
    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()].filter(
        (e) => tableNodeIds.has(e.source) && tableNodeIds.has(e.target),
      ),
    };
  }

  // Bound the row/file "detail" nodes so a large workspace (a big cloud) doesn't
  // ship + render tens of thousands of nodes — a force-directed graph can't lay
  // those out, so the view would freeze. The table topology above always renders
  // in full; here we cap per-table and against a global budget, and report what
  // was dropped (truncated/totalEntities) so the GUI can say "showing N of M".
  const maxDetailNodes = options.maxDetailNodes ?? 1200;
  const maxEntityNodesPerTable = options.maxEntityNodesPerTable ?? 50;
  const perTableEntityCount = new Map<string, number>();
  let detailNodeCount = 0;
  let truncated = false;
  const totalEntities = data.entities.length;

  for (const entity of data.entities) {
    if (detailNodeCount >= maxDetailNodes) {
      truncated = true;
      break;
    }
    const usedForTable = perTableEntityCount.get(entity.table) ?? 0;
    if (usedForTable >= maxEntityNodesPerTable) {
      truncated = true;
      continue;
    }
    perTableEntityCount.set(entity.table, usedForTable + 1);
    const entityId = `entity:${entity.table}:${entity.slug}`;
    addNode(nodes, {
      id: entityId,
      label: entity.slug,
      type: 'entity',
      table: entity.table,
      slug: entity.slug,
      status: entity.status,
    });
    addEdge(edges, {
      source: `table:${entity.table}`,
      target: entityId,
      type: 'contains',
      label: entity.table,
    });
    detailNodeCount++;

    for (const file of entity.files) {
      if (detailNodeCount >= maxDetailNodes) {
        truncated = true;
        break;
      }
      const fileId = `file:${file.path}`;
      addNode(nodes, {
        id: fileId,
        label: file.name,
        type: 'file',
        table: entity.table,
        slug: entity.slug,
        path: file.path,
        status: file.exists ? 'rendered' : 'missing',
      });
      addEdge(edges, { source: entityId, target: fileId, type: 'renders', label: file.name });
      detailNodeCount++;

      if (!file.exists) continue;
      const absPath = safeResolveInside(outputDir, file.path);
      const content = readFileSync(absPath, 'utf8');
      // file.path is POSIX-separated (see collectEntities); split on '/' so this
      // works regardless of the host OS separator.
      const fileDir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      for (const href of markdownLinks(content)) {
        let relTarget: string;
        try {
          // path.relative yields OS separators; normalize to POSIX so the id
          // matches the POSIX node ids built above.
          relTarget = relative(
            resolve(outputDir),
            safeResolveInside(outputDir, join(fileDir, href)),
          )
            .split(sep)
            .join('/');
        } catch {
          continue;
        }
        const targetId = `file:${relTarget}`;
        if (knownFileIds.has(targetId)) {
          addEdge(edges, { source: fileId, target: targetId, type: 'markdown', label: href });
          const targetOwner = fileOwners.get(targetId);
          if (targetOwner && targetOwner.table !== entity.table) {
            addEdge(edges, {
              source: `table:${entity.table}`,
              target: `table:${targetOwner.table}`,
              type: 'markdown',
              label: 'context link',
            });
          }
        }
      }
    }
  }

  for (const { table, definition } of data.parsed.entityContexts) {
    for (const [filename, spec] of Object.entries(definition.files)) {
      for (const target of sourceTargets(spec.source)) {
        addEdge(edges, {
          source: `table:${table}`,
          target: `table:${target.table}`,
          type: target.type,
          label: `${filename}: ${target.label}`,
        });
      }
    }
  }

  // Drop any edge that dangles into a node we didn't emit — chiefly the
  // hidden junction tables (an entity-context manyToMany source produces an
  // edge to its junctionTable, which is no longer a node). Keeps the graph
  // referentially consistent so the client never references a missing node.
  const presentNodeIds = new Set(nodes.keys());
  const liveEdges = [...edges.values()].filter(
    (e) => presentNodeIds.has(e.source) && presentNodeIds.has(e.target),
  );

  return { nodes: [...nodes.values()], edges: liveEdges, truncated, totalEntities };
}

export function getGuiProject(configPath: string, outputDir: string): GuiProjectSummary {
  return loadGuiData(configPath, outputDir).project;
}

export function getGuiEntities(configPath: string, outputDir: string): GuiEntitiesPayload {
  const data = loadGuiData(configPath, outputDir);
  return { tables: data.tables, entities: data.entities, hasManifest: data.manifest !== null };
}

/** Columns a pure junction may carry besides its two FK columns. */
const JUNCTION_ALLOWED_NONFK = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);

/**
 * A table is a junction iff it joins exactly two entities and carries NO
 * payload of its own: exactly two `belongsTo` relations AND every column is one
 * of those two FK columns or a system column (id/created_at/updated_at/
 * deleted_at). A table with extra scalar/data columns (e.g. `tasks` with a
 * `title`) is a first-class entity, not a junction — even if it happens to have
 * two foreign keys. This columns-aware check is the guard against treating a
 * real entity as a relationship (which previously exposed a DROP-TABLE path).
 * Junction tables are hidden from the Objects sidebar and dashboard cards and
 * collapse into a single many-to-many edge in the schema graph.
 *
 * NOTE: the client mirror `isJunction` in src/gui/app/script.ts MUST use the
 * identical predicate — keep them in lockstep.
 */
export function isJunctionTable(table: GuiTableSummary): boolean {
  const belongsTo = Object.values(table.relations).filter((r) => r.type === 'belongsTo');
  if (belongsTo.length !== 2 || Object.keys(table.relations).length !== 2) return false;
  const fkCols = new Set(belongsTo.map((r) => r.foreignKey));
  return table.columns.every((c) => fkCols.has(c) || JUNCTION_ALLOWED_NONFK.has(c));
}

/**
 * DB-only junction detection from a table's COLUMNS alone — for a cloud MEMBER,
 * who has no entity/relation config (relations live only in the owner's config,
 * never in the database) and so cannot use {@link isJunctionTable}. A lattice
 * junction is materialized as exactly `(id, "<x>_id", "<y>_id")` (see
 * `materializeJunction`), so once system columns are stripped the remainder is
 * exactly two `*_id` foreign-key columns with no payload of its own. This mirrors
 * isJunctionTable's "two FKs + no payload" rule using only the physical shape the
 * member can read from the catalog — keeping "a junction is not an object" true
 * for members the same way it is for the owner.
 */
export function isJunctionByColumns(columns: string[]): boolean {
  const payload = columns.filter((c) => !JUNCTION_ALLOWED_NONFK.has(c));
  return payload.length === 2 && payload.every((c) => c.endsWith('_id'));
}

/** Allowed non-FK columns for a DISPLAY-only link table (adds a display `name`). */
const LINK_DISPLAY_ALLOWED_NONFK = new Set([...JUNCTION_ALLOWED_NONFK, 'name']);

/**
 * DISPLAY predicate — hide pure link tables from object lists / sidebars / the
 * Markdown + Tables panels / graph nodes. Broader than the STRICT, deletion-safe
 * {@link isJunctionTable}: it ALSO catches a *physical* link table created WITHOUT
 * declared relations — e.g. an AI-built `files_<entity>` shaped
 * `(id, name, <x>_id, <y>_id, deleted_at)`. A display-only `name` label does not
 * make a link table a first-class object. This is NEVER used for any
 * destructive / graph-edge / auto-link path (those keep the strict rule), so the
 * broader match can't expose a DROP-TABLE on a misclassified entity. The client
 * mirror is `isJunction` in src/gui/app/modules/display-config.ts — keep in lockstep.
 */
export function isHiddenLinkTable(table: GuiTableSummary): boolean {
  if (isJunctionTable(table)) return true;
  const payload = table.columns.filter((c) => !LINK_DISPLAY_ALLOWED_NONFK.has(c));
  return payload.length === 2 && payload.every((c) => c.endsWith('_id'));
}

/** A junction table that connects the native `files` entity to another entity. */
export interface FileJunction {
  /** The junction table name. */
  junction: string;
  /** FK column on the junction pointing at `files`. */
  fileFk: string;
  /** The entity on the other side of the junction. */
  otherTable: string;
  /** FK column on the junction pointing at `otherTable`. */
  otherFk: string;
}

/**
 * Discover the junction tables that link `files` to another entity, with their
 * foreign-key columns. Used by ingest to auto-link a file to records it relates
 * to — only where such a junction already exists in the schema.
 */
export function fileJunctions(configPath: string, outputDir: string): FileJunction[] {
  const out: FileJunction[] = [];
  for (const t of getGuiEntities(configPath, outputDir).tables) {
    if (!isJunctionTable(t)) continue;
    const belongsTo = Object.values(t.relations).filter(
      (r): r is BelongsToRelation => r.type === 'belongsTo',
    );
    const fileRel = belongsTo.find((r) => r.table === 'files');
    const otherRel = belongsTo.find((r) => r.table !== 'files');
    if (fileRel && otherRel) {
      out.push({
        junction: t.name,
        fileFk: fileRel.foreignKey,
        otherTable: otherRel.table,
        otherFk: otherRel.foreignKey,
      });
    }
  }
  return out;
}

/** A junction edge as seen from one specific table's side. */
export interface TableJunction {
  /** The junction table name. */
  junction: string;
  /** FK column on the junction pointing at the table we asked about. */
  selfFk: string;
  /** The entity on the other side of the junction. */
  otherTable: string;
  /** FK column on the junction pointing at `otherTable`. */
  otherFk: string;
}

/**
 * Discover the junction tables that reference `table`, with the FK column that
 * points back at it and the FK/entity on the other side. Generalizes
 * fileJunctions() to any entity — used by row de-duplication to re-point a merged
 * row's many-to-many links onto the survivor. A self-referential junction (both
 * sides point at `table`) yields one entry per FK so both ends get re-pointed.
 */
export function tableJunctions(
  table: string,
  configPath: string,
  outputDir: string,
): TableJunction[] {
  const out: TableJunction[] = [];
  for (const t of getGuiEntities(configPath, outputDir).tables) {
    if (!isJunctionTable(t)) continue;
    const belongsTo = Object.values(t.relations).filter(
      (r): r is BelongsToRelation => r.type === 'belongsTo',
    );
    const selfRels = belongsTo.filter((r) => r.table === table);
    if (selfRels.length === 0) continue;
    for (const selfRel of selfRels) {
      const otherRel = belongsTo.find((r) => r.foreignKey !== selfRel.foreignKey);
      if (!otherRel) continue;
      out.push({
        junction: t.name,
        selfFk: selfRel.foreignKey,
        otherTable: otherRel.table,
        otherFk: otherRel.foreignKey,
      });
    }
  }
  return out;
}
