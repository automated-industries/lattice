import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Lattice } from '../lattice.js';
import { fieldToSqliteBaseType } from '../config/parser.js';
import { execSql, loadConfigDoc, saveConfigDoc } from '../gui/config-io.js';
import { recordLineage } from '../gui/lineage-store.js';
import { normalizeText } from '../dedup/normalize.js';
import { parseCellDate } from './asof.js';
import { normalizeName, sourceRecords } from './infer.js';
import type { DetectedView, InferredEntity, InferredType, ProposedSchema } from './types.js';

/**
 * Materialize an approved {@link ProposedSchema} into a Lattice workspace: create
 * the entity + dimension tables and the junctions, then load the rows (deduped)
 * and the links. Lattice becomes the system of record — the schema is persisted
 * to the workspace config so it survives a restart.
 *
 * Rows go through {@link Lattice.seed} (upsert by natural/content key → dedup +
 * idempotent re-apply). Junctions are written directly so the link column names
 * are fully controlled (`<entity>_id`).
 */

export interface MaterializeCtx {
  db: Lattice;
  /** Workspace config path. When set, the schema is persisted here (canonical). */
  configPath?: string | null;
}

/**
 * What to materialize:
 * - `schema`   — table structures + the deduped dimension values (the taxonomy /
 *   "dictionary") + views. No entity rows, no links.
 * - `contents` — the entity rows + their links, into tables that already exist
 *   (created idempotently if missing). No dimension values, no views.
 * - `both`     — schema + contents (the default).
 */
export type ImportMode = 'schema' | 'contents' | 'both';

/** A live step in the import pipeline, for streaming progress to the UI. */
export interface ImportProgress {
  phase: 'parse' | 'infer' | 'detect' | 'entities' | 'dimensions' | 'links' | 'views' | 'done';
  message: string;
  table?: string;
  count?: number;
}

export interface MaterializeOptions {
  /** Which parts to materialize (default `both`). */
  mode?: ImportMode;
  /**
   * Called as each step completes — drives the live pipeline view. May return a
   * promise; it is awaited, so a streaming caller can yield to the event loop
   * (flushing the socket) between steps. Without that yield, a synchronous DB
   * (SQLite) runs the whole import in one tick and the progress batches.
   */
  onProgress?: (p: ImportProgress) => void | Promise<void>;
  /**
   * Point-in-time snapshot date (ISO `YYYY-MM-DD`). When set, every entity + link
   * row is stamped with `as_of` and the row identity includes it, so re-importing
   * the same model at a new date APPENDS a dated snapshot (the prior one is kept)
   * and links resolve within each snapshot. Dimensions (the shared taxonomy) are
   * not dated. Omitted ⇒ the import is undated (re-import upserts in place).
   */
  asOf?: string | null;
  /**
   * Per-row snapshot date: the (normalized) name of a column whose value dates
   * each row individually, so one file can carry many periods. When set, each
   * row's `as_of` is read from this column (parsed per row), falling back to
   * {@link asOf} when a row's value isn't a date; applied to every entity that
   * has a column of this name. Identity + link resolution fold in the per-row
   * date exactly as the file-level {@link asOf} does.
   */
  asOfColumn?: string | null;
}

export interface MaterializeResult {
  mode: ImportMode;
  /** The file-level snapshot date stamped on the rows, or null. */
  asOf: string | null;
  /** The per-row date column used (each row dated from it), or null. */
  asOfColumn: string | null;
  tablesCreated: string[];
  rowsByTable: Record<string, number>;
  links: { junction: string; created: number; unresolved: number }[];
  /** Read-only views created for detected projections (master filtered by a column). */
  views: { name: string; master: string; rows: number }[];
}

type Row = Record<string, unknown>;

function coerce(v: unknown, type: InferredType): unknown {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'boolean') return v === true || v === 'true' || v === 1 ? 1 : 0;
  return v;
}

/** Stable content hash of a source record — the dedup key for keyless entities. */
function contentKey(record: Row): string {
  const parts = Object.keys(record)
    .sort()
    .map((k) => k + '=' + JSON.stringify(record[k] ?? null));
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function persistTable(
  configPath: string | null | undefined,
  name: string,
  fields: Record<string, unknown>,
): void {
  if (!configPath || !existsSync(configPath)) return;
  try {
    const doc = loadConfigDoc(configPath);
    doc.setIn(['entities', name], { fields, outputFile: name.toUpperCase() + '.md' });
    saveConfigDoc(configPath, doc);
  } catch {
    // Best-effort: defineLate already made the table usable this session.
  }
}

export async function materializeImport(
  ctx: MaterializeCtx,
  data: Record<string, unknown>,
  plan: ProposedSchema,
  views: DetectedView[] = [],
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const { db, configPath } = ctx;
  const mode: ImportMode = opts.mode ?? 'both';
  const doSchema = mode === 'schema' || mode === 'both'; // dimension values + views
  const doContents = mode === 'contents' || mode === 'both'; // entity rows + links
  const asOf = opts.asOf?.trim() ? opts.asOf.trim() : null; // file-level snapshot date
  const asOfColumn = opts.asOfColumn?.trim() ? opts.asOfColumn.trim() : null; // per-row date column
  const dated = asOf !== null || asOfColumn !== null;
  // The source key holding the per-row date, for a given entity (null if it has none).
  const asOfSourceKey = (entity: InferredEntity): string | null =>
    asOfColumn ? (entity.columns.find((c) => c.name === asOfColumn)?.sourceKey ?? null) : null;
  // A record's snapshot date: the chosen date column (parsed per row) wins, then
  // the file-level date, else null (undated).
  const rowAsOf = (entity: InferredEntity, record: Row): string | null => {
    const sk = asOfSourceKey(entity);
    if (sk) {
      const d = parseCellDate(record[sk]);
      if (d) return d;
    }
    return asOf;
  };
  // Dedup key for a source record — folds in its as-of date when dated, so the
  // same row at a new date is a distinct snapshot (not an overwrite).
  const recordKey = (entity: InferredEntity, record: Row): string => {
    const a = rowAsOf(entity, record);
    return a ? contentKey({ ...record, __as_of: a }) : contentKey(record);
  };
  // Map key for resolving a reference within its snapshot: as-of + a
  // `|` separator + the key. normalizeText strips punctuation, so `|` cannot appear in a value.
  const scopedKey = (a: string | null, keyVal: unknown): string =>
    (a ?? '') + '|' + normalizeText(keyVal);
  const report = async (p: ImportProgress): Promise<void> => {
    await opts.onProgress?.(p);
  };
  const tablesCreated: string[] = [];
  const rowsByTable: Record<string, number> = {};
  const links: MaterializeResult['links'] = [];
  const viewResults: MaterializeResult['views'] = [];
  const byName = new Map<string, InferredEntity>(plan.entities.map((e) => [e.name, e]));

  // ── Entities: create table + seed rows ──────────────────────────────
  for (const entity of plan.entities) {
    const keyless = entity.naturalKey === null;
    const columns: Record<string, string> = { id: 'TEXT PRIMARY KEY' };
    const fieldTypes: Record<string, string> = {};
    const cfgFields: Record<string, unknown> = { id: { type: 'uuid', primaryKey: true } };
    for (const c of entity.columns) {
      columns[c.name] = fieldToSqliteBaseType(c.type);
      fieldTypes[c.name] = c.type;
      cfgFields[c.name] = { type: c.type };
    }
    // When dated, every entity dedups by content_key (which folds in `as_of`), so
    // a new snapshot appends instead of overwriting; otherwise only keyless
    // entities need it.
    const needsContentKey = keyless || dated;
    if (needsContentKey) {
      columns.content_key = 'TEXT';
      cfgFields.content_key = { type: 'text' };
    }
    if (dated) {
      columns.as_of = 'TEXT';
      cfgFields.as_of = { type: 'text' };
    }
    columns.deleted_at = 'TEXT';
    cfgFields.deleted_at = { type: 'text' };

    if (!db.getRegisteredTableNames().includes(entity.name)) tablesCreated.push(entity.name);
    await db.defineLate(entity.name, { columns, fieldTypes, primaryKey: 'id' });
    persistTable(configPath, entity.name, cfgFields);
    await report({
      phase: 'entities',
      table: entity.name,
      message: `Created table ${entity.name}`,
    });

    if (doContents) {
      const records = sourceRecords(data, entity);
      const rows: Row[] = records.map((r) => {
        const row: Row = {};
        for (const c of entity.columns) row[c.name] = coerce(r[c.sourceKey], c.type);
        if (needsContentKey) row.content_key = recordKey(entity, r);
        if (dated) row.as_of = rowAsOf(entity, r);
        return row;
      });
      await db.seed({
        data: rows,
        table: entity.name,
        naturalKey: dated ? 'content_key' : (entity.naturalKey ?? 'content_key'),
      });
      const n = await db.count(entity.name);
      rowsByTable[entity.name] = n;
      // Provenance: record the import as a table-level (computed-tier) source.
      // objectId '*' is the table-level sentinel — per-row import lineage would
      // require an unbounded re-read of the just-seeded rows (bounded reads).
      await recordLineage(db.adapter, [
        {
          objectTable: entity.name,
          objectId: '*',
          sourceKind: 'import',
          tier: 'computed',
          relation: 'materialized_from',
          detailJson: JSON.stringify({ rows: n }),
        },
      ]);
      await report({
        phase: 'entities',
        table: entity.name,
        count: n,
        message: `Loaded ${String(n)} rows into ${entity.name}`,
      });
    }
  }

  // ── Dimensions: create table + seed distinct values ─────────────────
  for (const dim of plan.dimensions) {
    if (!db.getRegisteredTableNames().includes(dim.name)) tablesCreated.push(dim.name);
    await db.defineLate(dim.name, {
      columns: { id: 'TEXT PRIMARY KEY', value: 'TEXT', deleted_at: 'TEXT' },
      fieldTypes: { value: 'text' },
      primaryKey: 'id',
    });
    persistTable(configPath, dim.name, {
      id: { type: 'uuid', primaryKey: true },
      value: { type: 'text' },
      deleted_at: { type: 'text' },
    });

    // Dimension VALUES are the taxonomy / "dictionary" — part of the schema, so
    // they seed in `schema` and `both`, not in `contents`.
    if (doSchema) {
      // Distinct values (one row per normalized value, keeping a representative casing).
      const values = new Map<string, string>();
      for (const ename of dim.fromEntities) {
        const ent = byName.get(ename);
        if (!ent) continue;
        const records = sourceRecords(data, ent);
        const first = records[0];
        const srcKey = first
          ? Object.keys(first).find((k) => normalizeName(k) === dim.name)
          : undefined;
        if (!srcKey) continue;
        for (const r of records) {
          const v = r[srcKey];
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          const key = normalizeText(v);
          if (key !== '' && !values.has(key)) values.set(key, String(v));
        }
      }
      await db.seed({
        data: [...values.values()].map((value) => ({ value })),
        table: dim.name,
        naturalKey: 'value',
      });
      const n = await db.count(dim.name);
      rowsByTable[dim.name] = n;
      await report({
        phase: 'dimensions',
        table: dim.name,
        count: n,
        message: `Dimension ${dim.name}: ${String(n)} values`,
      });
    }
  }

  // ── Junctions: create + link ────────────────────────────────────────
  // Cache the key→id map per table (queried once via the library query path,
  // which has no row cap — unlike the HTTP route).
  const idMapCache = new Map<string, Map<string, string>>();
  // When `datedTarget`, the map key folds in each row's `as_of` (via scopedKey),
  // so a reference resolves within its own snapshot — a row exists once per
  // as-of, and per-row dates mean one map must cover every snapshot at once.
  // Dimensions are shared (no as_of), so they key on the bare value.
  async function idMap(
    table: string,
    keyCol: string,
    datedTarget: boolean,
  ): Promise<Map<string, string>> {
    const cacheKey = table + ':' + keyCol + ':' + (datedTarget ? 'D' : '');
    const cached = idMapCache.get(cacheKey);
    if (cached) return cached;
    const map = new Map<string, string>();
    for (const r of await db.query(table)) {
      const k = r[keyCol];
      if (k === null || k === undefined) continue;
      const mapKey = datedTarget ? scopedKey(r.as_of as string | null, k) : normalizeText(k);
      map.set(mapKey, String(r.id));
    }
    idMapCache.set(cacheKey, map);
    return map;
  }

  for (const link of plan.linkages) {
    const from = byName.get(link.fromEntity);
    if (!from) continue;
    const jName = link.junction ?? `${link.fromEntity}_${link.toEntity}`;
    const fromFk = `${link.fromEntity}_id`;
    const toFk = `${link.toEntity}_id`;

    const jCols: Record<string, string> = {
      id: 'TEXT PRIMARY KEY',
      [fromFk]: 'TEXT',
      [toFk]: 'TEXT',
    };
    const jCfg: Record<string, unknown> = {
      id: { type: 'uuid', primaryKey: true },
      [fromFk]: { type: 'uuid', ref: link.fromEntity },
      [toFk]: { type: 'uuid', ref: link.toEntity },
    };
    if (dated) {
      jCols.as_of = 'TEXT';
      jCfg.as_of = { type: 'text' };
    }
    if (!db.getRegisteredTableNames().includes(jName)) tablesCreated.push(jName);
    await db.defineLate(jName, { columns: jCols, primaryKey: 'id' });
    persistTable(configPath, jName, jCfg);

    // Links are contents (they connect rows), so they seed in `contents`/`both`.
    if (!doContents) continue;

    const fromKeyCol = from.naturalKey ?? 'content_key';
    // `from` is always an entity (dated when the import is dated); `to` may be a
    // dated entity or a shared dimension — only the dated side folds in as_of.
    const toIsEntity = byName.has(link.toEntity);
    const fromMap = await idMap(link.fromEntity, fromKeyCol, dated);
    const toMap = await idMap(link.toEntity, link.toKey, toIsEntity && dated);

    const seen = new Set<string>();
    // Pre-load existing edges so re-applying an import never duplicates links.
    for (const r of await db.query(jName)) {
      seen.add(String(r[fromFk]) + '|' + String(r[toFk]));
    }
    const unresolved = new Set<string>();
    let created = 0;
    for (const record of sourceRecords(data, from)) {
      const a = rowAsOf(from, record); // this row's snapshot date
      const fromKeyVal =
        from.naturalKey === null ? recordKey(from, record) : record[from.naturalKeySource ?? ''];
      const fromId = fromMap.get(dated ? scopedKey(a, fromKeyVal) : normalizeText(fromKeyVal));
      if (!fromId) continue;
      const raw = record[link.fromField];
      const refs = Array.isArray(raw) ? raw : [raw];
      for (const ref of refs) {
        if (ref === null || ref === undefined || ref === '') continue;
        // Resolve a dated target within this row's snapshot; a dimension is shared.
        const toId = toMap.get(toIsEntity && dated ? scopedKey(a, ref) : normalizeText(ref));
        if (!toId) {
          unresolved.add(normalizeText(ref));
          continue;
        }
        const edge = fromId + '|' + toId;
        if (seen.has(edge)) continue;
        seen.add(edge);
        await db.insert(
          jName,
          dated ? { [fromFk]: fromId, [toFk]: toId, as_of: a } : { [fromFk]: fromId, [toFk]: toId },
        );
        created++;
      }
    }
    rowsByTable[jName] = created;
    links.push({ junction: jName, created, unresolved: unresolved.size });
    await report({
      phase: 'links',
      table: jName,
      count: created,
      message: `Linked ${String(created)} ${jName}`,
    });
  }

  // ── Reconstructed views: read-only projections of a master, no duplicate rows ──
  // Views are part of the schema (a derived structure), so they build in
  // `schema`/`both`. (They also need their master table to exist, which it does
  // after the entity pass above.)
  if (doSchema) {
    for (const v of views) {
      const filt = v.filterValue.replace(/'/g, "''");
      await execSql(db, `DROP VIEW IF EXISTS "${v.name}"`);
      await execSql(
        db,
        `CREATE VIEW "${v.name}" AS SELECT * FROM "${v.master}" WHERE "${v.filterColumn}" = '${filt}'`,
      );
      // Register so it lists as an object + is queryable; introspect FIRST so the
      // def's columns match the view exactly (defineLate's CREATE TABLE IF NOT
      // EXISTS no-ops over the existing view, then caches the real columns).
      const cols = await db.introspectColumns(v.name);
      await db.defineLate(v.name, {
        columns: Object.fromEntries(cols.map((c) => [c, 'TEXT'])),
        render: () => '',
      });
      if (!tablesCreated.includes(v.name)) tablesCreated.push(v.name);
      const rows = await db.count(v.name);
      rowsByTable[v.name] = rows;
      viewResults.push({ name: v.name, master: v.master, rows });
      await report({
        phase: 'views',
        table: v.name,
        count: rows,
        message: `View ${v.name}: ${String(rows)} rows`,
      });
    }
  }

  await report({ phase: 'done', message: 'Import complete' });
  return { mode, asOf, asOfColumn, tablesCreated, rowsByTable, links, views: viewResults };
}
