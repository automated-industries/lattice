import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseConfigFile, type ParsedConfig } from '../config/parser.js';
import { entityFileNames, readManifest, type LatticeManifest } from '../lifecycle/manifest.js';
import type { EntityFileSource, EnrichmentLookup } from '../schema/entity-context.js';
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
  /** Team cloud only: this table is shared to the whole team. Set by the server. */
  shared?: boolean;
  /** Team cloud only: the operator owns this table. Set by the server. */
  ownedByMe?: boolean;
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
  type: 'contains' | 'renders' | 'belongsTo' | 'hasMany' | 'manyToMany' | 'markdown';
  label: string;
}

export interface GuiGraphPayload {
  nodes: GuiGraphNode[];
  edges: GuiGraphEdge[];
}

interface GuiData {
  parsed: ParsedConfig;
  manifest: LatticeManifest | null;
  project: GuiProjectSummary;
  entities: GuiEntitySummary[];
  tables: GuiTableSummary[];
}

function tableToSummary(name: string, definition: TableDefinition): GuiTableSummary {
  return {
    name,
    columns: Object.keys(definition.columns),
    outputFile: definition.outputFile ?? `.schema-only/${name}.md`,
    relations: definition.relations ?? {},
    ...(definition.description ? { description: definition.description } : {}),
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

export function loadGuiData(configPath: string, outputDir: string): GuiData {
  const parsed = parseConfigFile(configPath);
  const manifest = readManifest(outputDir);
  const tables = parsed.tables.map(({ name, definition }) => tableToSummary(name, definition));
  const entities = collectEntities(outputDir, manifest);

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
}

export function buildGuiGraph(
  configPath: string,
  outputDir: string,
  options: BuildGuiGraphOptions = {},
): GuiGraphPayload {
  const data = loadGuiData(configPath, outputDir);
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

  for (const entity of data.entities) {
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

    for (const file of entity.files) {
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

  return { nodes: [...nodes.values()], edges: liveEdges };
}

export function getGuiProject(configPath: string, outputDir: string): GuiProjectSummary {
  return loadGuiData(configPath, outputDir).project;
}

export function getGuiEntities(configPath: string, outputDir: string): GuiEntitiesPayload {
  const data = loadGuiData(configPath, outputDir);
  return { tables: data.tables, entities: data.entities, hasManifest: data.manifest !== null };
}

/**
 * A table is a junction iff it has exactly two `belongsTo` relations.
 * Junction tables are hidden from the Objects sidebar and dashboard cards;
 * their rows are editable via the Data Model view.
 */
export function isJunctionTable(table: GuiTableSummary): boolean {
  const belongsTo = Object.values(table.relations).filter((r) => r.type === 'belongsTo');
  return belongsTo.length === 2 && Object.keys(table.relations).length === 2;
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
