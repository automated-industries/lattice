/**
 * Persisted + memoized schema descriptor for one external-DB connection. The
 * connector's `models()` is SYNCHRONOUS (the SPI + sync engine call it inline),
 * but introspecting an external DB is async — so introspection happens in the
 * async `connect()`/refresh paths, persists the descriptor in the machine-local
 * encrypted store (alongside the credentials), and `models()` reads it back
 * synchronously here. No schema migration: this rides the existing encrypted
 * credential store, not the registry table.
 */

import {
  getAssistantCredential,
  setAssistantCredential,
  deleteAssistantCredential,
} from '../../framework/user-config.js';
import type { TableDefinition } from '../../types.js';
import type { ConnectedModelDef } from '../types.js';

export interface DbColumnDesc {
  /** External column name. */
  name: string;
  /** Mapped Lattice column spec. */
  sqlSpec: 'TEXT' | 'INTEGER' | 'REAL';
}

export interface DbTableDesc {
  /** External table name within the source schema. */
  name: string;
  columns: DbColumnDesc[];
  /** Primary-key columns in key order (may be empty for a keyless table). */
  pk: string[];
  /** Whether this table is imported (table-level selection). */
  selected: boolean;
  /**
   * Single-column FOREIGN KEYs introspected from the remote (composite FKs are
   * dropped at introspection time). Materialized as graph edges between the
   * imported tables so a connected database's relational structure carries over.
   * Optional — descriptors persisted before FK introspection existed lack it.
   */
  fks?: { column: string; refTable: string; refColumn: string }[];
}

export interface DbSchemaDescriptor {
  dialect: string;
  /** Source schema (e.g. `public`). */
  schema: string;
  /** Sanitized slug namespacing the imported Lattice tables (from the display name). */
  prefix: string;
  tables: DbTableDesc[];
}

const schemaKind = (connectionId: string): string => `db_source_schema:${connectionId}`;

// In-process memo so repeated synchronous models() calls within a session don't
// re-decrypt/re-parse. Rebuilt on connect + each refresh.
const memo = new Map<string, DbSchemaDescriptor>();

export function getSchemaDescriptor(connectionId: string): DbSchemaDescriptor | null {
  const cached = memo.get(connectionId);
  if (cached) return cached;
  const raw = getAssistantCredential(schemaKind(connectionId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as DbSchemaDescriptor;
    memo.set(connectionId, d);
    return d;
  } catch {
    return null;
  }
}

export function setSchemaDescriptor(connectionId: string, descriptor: DbSchemaDescriptor): void {
  memo.set(connectionId, descriptor);
  setAssistantCredential(schemaKind(connectionId), JSON.stringify(descriptor));
}

export function clearSchemaDescriptor(connectionId: string): void {
  memo.delete(connectionId);
  deleteAssistantCredential(schemaKind(connectionId));
}

/** Lowercase, non-alphanumeric→underscore slug, bounded; never empty. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || 'db';
}

/** The imported Lattice table name for an external table (namespaced by prefix). */
export function latticeTableName(prefix: string, externalTable: string): string {
  return `db_${prefix}_${slugify(externalTable)}`;
}

/**
 * Natural key for an imported table: a single-column PK is used directly; a
 * composite PK or a keyless table gets a synthesized `_pk` (joined PK values, or
 * a content hash for keyless rows — see the connector's row mapping).
 */
export function naturalKeyFor(t: Pick<DbTableDesc, 'pk'>): { key: string; synthesized: boolean } {
  const [first] = t.pk;
  if (t.pk.length === 1 && first !== undefined) return { key: first, synthesized: false };
  return { key: '_pk', synthesized: true };
}

/**
 * Build the Lattice {@link ConnectedModelDef}s for the selected tables. Pure +
 * synchronous so `models()` can return immediately. Each table maps to a Lattice
 * table carrying the standard lifecycle/lineage columns + the external columns,
 * with a `source` descriptor (so the row stamps land it in the SOURCE·INPUTS tier).
 */
export function buildModelDefs(
  connectionId: string,
  descriptor: DbSchemaDescriptor,
): ConnectedModelDef[] {
  const toolkit = `db_source:${connectionId}`;
  const out: ConnectedModelDef[] = [];
  // Which imported tables an FK can point AT: the referenced table must itself be
  // imported, and the referenced column must be its single-column PK (so the FK
  // value maps 1:1 onto the imported row's — later connector-namespaced — key).
  const importable = new Map(descriptor.tables.filter((t) => t.selected).map((t) => [t.name, t]));
  for (const t of descriptor.tables) {
    if (!t.selected) continue;
    const { key: naturalKey } = naturalKeyFor(t);
    const columns: Record<string, string> = {
      [naturalKey]: 'TEXT PRIMARY KEY',
      deleted_at: 'TEXT',
      created_at: 'TEXT',
      updated_at: 'TEXT',
    };
    for (const c of t.columns) {
      if (c.name === naturalKey) continue; // already declared as the PK
      columns[c.name] = c.sqlSpec;
    }
    const definition: TableDefinition = {
      columns,
      primaryKey: naturalKey,
      source: {
        connector: 'db_source',
        toolkit,
        model: t.name,
        naturalKey,
        defaultVisibility: 'private',
      },
      outputFile: `connectors/db-source/${descriptor.prefix}/${slugify(t.name)}.md`,
      description: `Imported from external database table "${t.name}".`,
      render: 'default-detail',
    };
    // Remote FOREIGN KEYs → graph edges between the imported tables, so the
    // source database's relational structure carries over (the sync engine
    // namespaces the FK values and derives the edges — same machinery as the
    // other connectors). Only FK → single-column-PK links qualify; anything
    // else can't map onto the imported row keys.
    const graphEdges = (t.fks ?? [])
      .filter((fk) => {
        // An FK that IS this table's own PK (a 1:1 table) is skipped: the sync
        // engine namespaces the PK once at ingest and would double-namespace it
        // as an FK column, corrupting the key.
        if (fk.column === naturalKey) return false;
        const ref = importable.get(fk.refTable);
        return !!ref && ref.pk.length === 1 && ref.pk[0] === fk.refColumn;
      })
      .map((fk) => ({
        fkColumn: fk.column,
        dstTable: latticeTableName(descriptor.prefix, fk.refTable),
        type: 'references',
      }));
    out.push({
      model: t.name,
      table: latticeTableName(descriptor.prefix, t.name),
      naturalKey,
      definition,
      ...(graphEdges.length ? { graphEdges } : {}),
    });
  }
  return out;
}
