import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseConfigFile, type ParsedConfig } from '../config/parser.js';
import { entityFileNames, readManifest, type LatticeManifest } from '../lifecycle/manifest.js';
import type { EntityFileSource, EnrichmentLookup } from '../schema/entity-context.js';
import type { Relation, TableDefinition } from '../types.js';

export interface GuiTableSummary {
  name: string;
  columns: string[];
  outputFile: string;
  relations: Record<string, Relation>;
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
  };
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
        fileSummary(outputDir, join(entry.directoryRoot, slug, filename)),
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

export function buildGuiGraph(configPath: string, outputDir: string): GuiGraphPayload {
  const data = loadGuiData(configPath, outputDir);
  const nodes = new Map<string, GuiGraphNode>();
  const edges = new Map<string, GuiGraphEdge>();
  const fileOwners = new Map<string, GuiEntitySummary>();
  for (const entity of data.entities) {
    for (const file of entity.files) {
      fileOwners.set(`file:${file.path}`, entity);
    }
  }
  const knownFileIds = new Set(fileOwners.keys());

  for (const table of data.tables) {
    const tableId = `table:${table.name}`;
    addNode(nodes, { id: tableId, label: table.name, type: 'table', table: table.name });
    for (const [relationName, relation] of Object.entries(table.relations)) {
      addEdge(edges, {
        source: tableId,
        target: `table:${relation.table}`,
        type: relation.type,
        label: relationName,
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
      const fileDir = file.path.includes(sep) ? file.path.slice(0, file.path.lastIndexOf(sep)) : '';
      for (const href of markdownLinks(content)) {
        let relTarget: string;
        try {
          relTarget = relative(
            resolve(outputDir),
            safeResolveInside(outputDir, join(fileDir, href)),
          );
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

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
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

