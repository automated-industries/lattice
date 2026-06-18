import { join, basename, isAbsolute, resolve, sep } from 'node:path';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import { runAsyncOrSync, allAsyncOrSync } from '../db/adapter.js';
import type { RenderResult, Row } from '../types.js';
import { atomicWrite, contentHash, rowVersionHash, probeDirWritable } from './writer.js';
import { applyTokenBudget } from './token-budget.js';
import {
  resolveEntitySource,
  truncateContent,
  appendQueryOptions,
  type ProtectionContext,
} from './entity-query.js';
import type {
  EntityContextDefinition,
  EntityFileSource,
  BelongsToSource,
} from '../schema/entity-context.js';
import { compileEntityRender } from './entity-templates.js';
import type {
  EntityContextManifestEntry,
  LatticeManifest,
  EntityFileManifestInfo,
} from '../lifecycle/manifest.js';
import { writeManifest } from '../lifecycle/manifest.js';
import type { CleanupOptions, CleanupResult } from '../lifecycle/cleanup.js';
import { cleanupEntityContexts } from '../lifecycle/cleanup.js';
import type { RenderOptions } from './progress.js';
import { ProgressThrottle } from './progress.js';
import { mapWithConcurrency } from '../concurrency.js';

/**
 * Yield back to the event loop every this-many entities during the per-entity
 * render loop. SQLite adapter queries resolve synchronously, so a large render
 * would otherwise starve the HTTP server (delaying an abort from taking effect)
 * and freeze the GUI. The yield is cheap and only happens a handful of times.
 */
const YIELD_EVERY_ENTITIES = 200;

/**
 * How many entity-context tables to render at once. Bounded on purpose: each
 * table loads its whole row set, so an unbounded fan-out would multiply peak
 * memory + DB egress. A small cap lets several tables progress simultaneously
 * (each card advancing at its own rate) without a thundering herd of full-table
 * reads.
 */
const RENDER_TABLE_CONCURRENCY = 4;

/**
 * Sentinel render function assigned to tables registered without a `render`
 * spec. Such tables would only emit an empty `.schema-only/<table>.md`. The
 * value is a shared singleton (not a fresh closure per table) so the render
 * engine can identity-detect spec-less tables via `def.render === NOOP_RENDER`
 * and, when `skipEmpty` is enabled, avoid reading the whole table off the wire
 * just to produce an empty file.
 */
export const NOOP_RENDER = (): string => '';

/**
 * Scalar-key guard for the belongsTo batch. PK/FK cells used as Map keys must be
 * primitives so `String(v)` is a stable, lossless normalization that matches
 * SQL's `=` coercion. A non-scalar (object/array) cell is treated as no-match
 * (an empty result, i.e. per-row-equivalent) rather than batched.
 */
function isScalarKey(v: unknown): v is string | number | bigint | boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean';
}

export class RenderEngine {
  private readonly _schema: SchemaManager;
  private readonly _adapter: StorageAdapter;
  private readonly _getTaskContext: () => string;
  /** When true, skip the read + write for spec-less (no-op render) tables. */
  private readonly _skipEmpty: boolean;
  /**
   * Per-viewer read-relation resolver. When set (a cloud MEMBER open), every
   * table read during render is routed through `_readRel(table)` — mapping a
   * masked table to its `<table>_v` view so the rows that reach disk are already
   * row-filtered + cell-masked by Postgres. It is ENGINE STATE (not a render
   * option) on purpose: the debounced auto-render path re-renders with no opts
   * after every member write, so a resolver carried only on RenderOptions would
   * silently revert post-write renders to the base table. Unset (owner / SQLite)
   * → identity → byte-identical to the prior behavior.
   */
  private _readRel: (table: string) => string = (t) => t;
  /**
   * Optional per-viewer fold applied to an entity-context table's rows after the
   * RLS-filtered read, before they are rendered. On a cloud MEMBER open it
   * overlays the viewer-visible DERIVED observations (the per-viewer enrichment
   * values) onto each ground row. Unset (owner / SQLite) → ground truth renders
   * as-is. Like `_readRel`, it is engine state so the post-write auto-render
   * applies it too.
   */
  private _foldRows: ((table: string, rows: Row[]) => Promise<Row[]>) | undefined;

  /**
   * Batch the SAFE-SUBSET of `belongsTo` sources (reference == the target's
   * single-column PK, no orderBy/limit, unprotected) into one
   * `WHERE pk IN (...)` read per (target+filters+softDelete) group instead of
   * one query per parent row. Default on; the identity test renders the same
   * fixture off vs on in one process by toggling
   * `LATTICE_RENDER_BELONGSTO_BATCH`.
   */
  private readonly _batchBelongsTo: boolean;

  constructor(
    schema: SchemaManager,
    adapter: StorageAdapter,
    getTaskContext?: () => string,
    options?: { skipEmpty?: boolean; batchBelongsTo?: boolean },
  ) {
    this._schema = schema;
    this._adapter = adapter;
    this._getTaskContext = getTaskContext ?? (() => '');
    this._skipEmpty = options?.skipEmpty ?? false;
    this._batchBelongsTo =
      options?.batchBelongsTo ?? process.env.LATTICE_RENDER_BELONGSTO_BATCH !== '0';
  }

  /** Install the per-viewer read-relation resolver (see `_readRel`). */
  setRenderReadRelation(fn: (table: string) => string): void {
    this._readRel = fn;
  }

  /** Install the per-viewer fold applied to entity rows before render (see `_foldRows`). */
  setRenderFold(fn: (table: string, rows: Row[]) => Promise<Row[]>): void {
    this._foldRows = fn;
  }

  async render(outputDir: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const start = Date.now();
    const filesWritten: string[] = [];
    const counters = { skipped: 0 };
    const signal = opts.signal;
    const throttle = new ProgressThrottle(opts.onProgress);

    // Convert a disk-full / read-only-mount failure into a clean throw BEFORE
    // any live file is touched. On failure the prior rendered tree + manifest
    // stay the record (the manifest is written last, so it is never committed
    // over a partial tree) and the error is re-raised. No try/catch wraps the
    // phases — the commit point stays the final writeManifest below.
    this._preflightWritable(outputDir);

    // Single-table renders (phase 1 — fast; lightweight table-done only).
    for (const [name, def] of this._schema.getTables()) {
      // Bail before each table if the render was aborted (e.g. a workspace
      // switch). Returns the partial manifest, which the caller discards.
      if (signal?.aborted) return this._abortedResult(filesWritten, counters, start);
      // Opt-in: a spec-less table renders to an empty `.schema-only` file, so
      // when skipEmpty is on we skip both the full-table read and the write —
      // avoiding pulling a whole (possibly large) table off the wire for an
      // empty file. Default-off path below is unchanged.
      if (this._skipEmpty && def.render === NOOP_RENDER) continue;
      let rows = await this._schema.queryTable(this._adapter, name, this._readRel);
      if (def.relevanceFilter) {
        const ctx = this._getTaskContext();
        rows = rows.filter((row) => def.relevanceFilter?.(row, ctx));
      }
      if (def.filter) rows = def.filter(rows);
      // Reward tracking: prune low-scoring rows and sort by reward
      if (def.rewardTracking) {
        if (def.pruneBelow !== undefined) {
          const threshold = def.pruneBelow;
          const toPrune = rows.filter(
            (r) => (r._reward_count as number) > 0 && (r._reward_total as number) < threshold,
          );
          if (toPrune.length > 0) {
            for (const r of toPrune) {
              const pkCol = this._schema.getPrimaryKey(name)[0] ?? 'id';
              await runAsyncOrSync(
                this._adapter,
                `UPDATE "${name}" SET deleted_at = datetime('now') WHERE "${pkCol}" = ?`,
                [r[pkCol]],
              );
            }
            rows = rows.filter(
              (r) => (r._reward_count as number) === 0 || (r._reward_total as number) >= threshold,
            );
          }
        }
        // Sort by reward descending (unless prioritizeBy overrides)
        if (!def.prioritizeBy) {
          rows.sort((a, b) => (b._reward_total as number) - (a._reward_total as number));
        }
      }
      if (def.enrich) {
        for (const fn of def.enrich) rows = fn(rows);
      }
      const content = def.tokenBudget
        ? applyTokenBudget(rows, def.render, def.tokenBudget, def.prioritizeBy)
        : def.render(rows);
      const filePath = join(outputDir, def.outputFile);
      if (atomicWrite(filePath, content)) {
        filesWritten.push(filePath);
      } else {
        counters.skipped++;
      }
      // Phase-1 tables are fast: emit a lightweight table-done only (no
      // per-entity progress). The `force` path is never throttled.
      throttle.force({
        kind: 'table-done',
        table: name,
        entitiesRendered: rows.length,
        entitiesTotal: rows.length,
        tableIndex: 0,
        tableCount: 0,
        pct: 100,
      });
    }

    // Multi-table renders (phase 2 — fast; lightweight table-done only).
    for (const [name, def] of this._schema.getMultis()) {
      if (signal?.aborted) return this._abortedResult(filesWritten, counters, start);
      const keys = await def.keys();
      const tables: Record<string, import('../types.js').Row[]> = {};

      if (def.tables) {
        for (const t of def.tables) {
          tables[t] = await this._schema.queryTable(this._adapter, t, this._readRel);
        }
      }

      for (const key of keys) {
        const content = def.render(key, tables);
        const filePath = join(outputDir, def.outputFile(key));
        if (atomicWrite(filePath, content)) {
          filesWritten.push(filePath);
        } else {
          counters.skipped++;
        }
      }
      throttle.force({
        kind: 'table-done',
        table: name,
        entitiesRendered: keys.length,
        entitiesTotal: keys.length,
        tableIndex: 0,
        tableCount: 0,
        pct: 100,
      });
    }

    // Entity context renders — the heavy phase, with per-entity progress.
    const entityContextManifest = await this._renderEntityContexts(
      outputDir,
      filesWritten,
      counters,
      throttle,
      signal,
    );

    // An abort during entity rendering surfaces as a null manifest; bail with
    // the partial result so the caller can discard it.
    if (entityContextManifest === null) {
      return this._abortedResult(filesWritten, counters, start);
    }

    // Write manifest if there are any entity contexts
    if (this._schema.getEntityContexts().size > 0) {
      writeManifest(outputDir, {
        version: 2,
        generated_at: new Date().toISOString(),
        entityContexts: entityContextManifest,
      });
    }

    const result = {
      filesWritten,
      filesSkipped: counters.skipped,
      durationMs: Date.now() - start,
    };

    // Terminal progress event — the render finished without being aborted.
    throttle.force({
      kind: 'done',
      table: null,
      entitiesRendered: 0,
      entitiesTotal: 0,
      tableIndex: 0,
      tableCount: 0,
      pct: 100,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Pre-flight writability check over the STABLE target directories before any
   * live file is written: the output root, the `.lattice` manifest dir, and each
   * entity context's directory root. Each is probed by writing + deleting a
   * sentinel INSIDE the directory, which is what surfaces an output-volume
   * disk-full or read-only mount up front. A failure here throws before a single
   * live byte is touched, so the prior rendered tree + manifest stay the record
   * and the error is re-raised to the caller. Per-row leaf directories are not
   * enumerated (that would require reading the rows); a failure isolated to one
   * leaf still re-raises loudly and leaves the prior manifest intact, it is just
   * not pre-empted.
   */
  private _preflightWritable(outputDir: string): void {
    const dirs = new Set<string>([outputDir, join(outputDir, '.lattice')]);
    for (const [table, def] of this._schema.getEntityContexts()) {
      dirs.add(join(outputDir, def.directoryRoot ?? table));
    }
    for (const dir of dirs) probeDirWritable(dir);
  }

  /**
   * Build the partial RenderResult to return when a render is aborted. No
   * `done` event is emitted — the caller treats abort as "discard the partial
   * tree", not as a successful completion.
   */
  private _abortedResult(
    filesWritten: string[],
    counters: { skipped: number },
    start: number,
  ): RenderResult {
    return {
      filesWritten,
      filesSkipped: counters.skipped,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run orphan cleanup using the previous manifest.
   * Called by reconcile() and optionally by the watch loop.
   *
   * @param newManifest - Optional: the manifest just written by render().
   *   When provided, step 2 (stale files in surviving entity dirs) compares
   *   old vs new manifest entries, catching omitIfEmpty files that were written
   *   before but skipped in the current render cycle.
   */
  async cleanup(
    outputDir: string,
    prevManifest: LatticeManifest | null,
    options: CleanupOptions = {},
    newManifest?: LatticeManifest | null,
  ): Promise<CleanupResult> {
    const entityContexts = this._schema.getEntityContexts();
    const currentSlugsByTable = new Map<string, Set<string>>();
    for (const [table, def] of entityContexts) {
      // Thread the per-viewer resolver so the stale-file slug set is computed
      // from the SAME (member-visible) row set the render wrote — otherwise
      // cleanup would prune the member's own just-rendered files.
      const rows = await this._schema.queryTable(this._adapter, table, this._readRel);
      const slugs = new Set(rows.map((row) => def.slug(row)));
      currentSlugsByTable.set(table, slugs);
    }
    return cleanupEntityContexts(
      outputDir,
      entityContexts,
      currentSlugsByTable,
      prevManifest,
      options,
      newManifest,
    );
  }

  /**
   * Narrow a source to the SAFE batchable belongsTo subset, or return null.
   * Batchable ⇔ belongsTo AND unprotected AND no orderBy/limit (per-parent
   * semantics a global IN-query would misapply) AND the effective reference
   * column equals the target's SINGLE-column primary key — so `WHERE pk IN (...)`
   * yields ≤1 row per key, exactly what the per-row belongsTo returns.
   * `filters`/`softDelete` ARE batched: they are row-local predicates and
   * PK-uniqueness still bounds each key to ≤1 surviving row.
   */
  private _batchableBelongsTo(
    source: EntityFileSource,
    protectedTables: ReadonlySet<string>,
  ): BelongsToSource | null {
    if (!this._batchBelongsTo) return null;
    if (source.type !== 'belongsTo') return null;
    if (protectedTables.has(source.table)) return null;
    if (source.orderBy !== undefined || source.limit !== undefined) return null;
    const pk = this._schema.getPrimaryKey(source.table);
    if (pk.length !== 1) return null;
    const ref = source.references ?? 'id';
    if (pk[0] !== ref) return null;
    return source;
  }

  /** Group key: same target + reference + filters + softDelete ⇒ one IN-read. */
  private _belongsToBatchKey(source: BelongsToSource): string {
    return JSON.stringify([
      source.table,
      source.references ?? 'id',
      source.filters ?? null,
      !!source.softDelete,
    ]);
  }

  /**
   * Normalize a scalar key so the JS Map's SameValueZero equality matches SQL's
   * `=` coercion (e.g. a number FK vs a number-valued PK). Used identically on
   * both insert and lookup.
   */
  private static _normKey(v: string | number | bigint | boolean): string {
    return String(v);
  }

  /**
   * Prefetch the batchable belongsTo sources for one entity-context table.
   * For each (target+filters+softDelete) group, issue exactly ONE
   * `SELECT * FROM "<readRel(table)>" WHERE "<ref>" IN (?,...)` over the DISTINCT
   * non-null parent FK values, then build `Map<normKey, Row>` (first-write-wins;
   * ≤1 per key since ref == PK). Reads THROUGH `_readRel` so a masked target
   * reads `<table>_v`. Abort-guarded; an empty key set issues no query.
   * Returns `Map<groupKey, Map<normKey, Row>>`, or null if aborted.
   */
  private async _prefetchBelongsToBatches(
    def: EntityContextDefinition,
    entityRows: Row[],
    protectedTables: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, Map<string, Row>> | null> {
    const groups = new Map<string, BelongsToSource>();
    for (const spec of Object.values(def.files)) {
      const mergeDefaults =
        def.sourceDefaults &&
        spec.source.type !== 'self' &&
        spec.source.type !== 'custom' &&
        spec.source.type !== 'enriched';
      const source = mergeDefaults
        ? ({ ...def.sourceDefaults, ...spec.source } as EntityFileSource)
        : spec.source;
      const batchable = this._batchableBelongsTo(source, protectedTables);
      if (!batchable) continue;
      const key = this._belongsToBatchKey(batchable);
      if (!groups.has(key)) groups.set(key, batchable);
    }
    if (groups.size === 0) return new Map();

    const result = new Map<string, Map<string, Row>>();
    for (const [groupKey, source] of groups) {
      if (signal?.aborted) return null;
      const keySet = new Set<string>();
      const rawByKey = new Map<string, unknown>();
      for (const row of entityRows) {
        const fkVal = row[source.foreignKey];
        if (fkVal == null || !isScalarKey(fkVal)) continue;
        const k = RenderEngine._normKey(fkVal);
        if (!keySet.has(k)) {
          keySet.add(k);
          rawByKey.set(k, fkVal);
        }
      }
      const byKey = new Map<string, Row>();
      result.set(groupKey, byKey);
      if (keySet.size === 0) continue; // empty key set → no IN () query
      const from = this._readRel(source.table);
      const refCol = source.references ?? 'id';
      const keys = [...rawByKey.values()];
      const params: unknown[] = [...keys];
      let sql = `SELECT * FROM "${from}" WHERE "${refCol}" IN (${keys
        .map(() => '?')
        .join(', ')})`;
      sql = appendQueryOptions(sql, params, source);
      const rows = await allAsyncOrSync(this._adapter, sql, params);
      for (const r of rows) {
        const refVal = r[refCol];
        if (refVal == null || !isScalarKey(refVal)) continue;
        const k = RenderEngine._normKey(refVal);
        if (!byKey.has(k)) byKey.set(k, r);
      }
    }
    return result;
  }

  /**
   * Render all entity context definitions.
   * Mutates `filesWritten` and `counters` in place.
   * Returns manifest data for the entity contexts rendered this cycle, or
   * `null` if the render was aborted mid-flight (the caller discards the
   * partial tree). Progress is reported through `throttle`; abort is observed
   * via `signal`.
   */
  private async _renderEntityContexts(
    outputDir: string,
    filesWritten: string[],
    counters: { skipped: number },
    throttle: ProgressThrottle,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, EntityContextManifestEntry> | null> {
    // Build set of protected table names for source filtering
    const protectedTables = new Set<string>();
    for (const [t, d] of this._schema.getEntityContexts()) {
      if (d.protected) protectedTables.add(t);
    }

    const entityTables = [...this._schema.getEntityContexts()];
    const tableCount = entityTables.length;
    if (signal?.aborted) return null;

    // Render tables CONCURRENTLY (bounded) so several advance at once, each at
    // its own rate, instead of strictly one-after-another. The per-table
    // ProgressThrottle keeps every card's % flowing independently; the cap keeps
    // the number of in-flight whole-table reads small (peak memory + DB egress).
    const renderedEntries = await mapWithConcurrency(
      entityTables,
      RENDER_TABLE_CONCURRENCY,
      async ([table, def], tableIndex): Promise<EntityContextManifestEntry | null> => {
        // Bail at the top of each entity-context table if aborted.
        if (signal?.aborted) return null;
        const entityPk = this._schema.getPrimaryKey(table)[0] ?? 'id';
        const baseRows = await this._schema.queryTable(this._adapter, table, this._readRel);
        // Per-viewer enrichment: overlay the viewer-visible derived observations
        // onto the RLS-filtered ground rows (no-op when no fold is installed).
        const allRows = this._foldRows ? await this._foldRows(table, baseRows) : baseRows;
        const directoryRoot = def.directoryRoot ?? table;

        // Prefetch the SAFE-SUBSET belongsTo reads for this table as one
        // `WHERE pk IN (...)` per group (vs one query per parent row). Routed
        // through `_readRel`, so a masked target reads `<table>_v`. A null
        // return means the render was aborted — bail and discard the partial.
        const belongsToBatches = await this._prefetchBelongsToBatches(
          def,
          allRows,
          protectedTables,
          signal,
        );
        if (belongsToBatches === null) return null;

        // `entitiesTotal` is the free denominator already read above — no
        // pre-count pass. Per-table % is exact: entitiesRendered / entitiesTotal.
        const entitiesTotal = allRows.length;
        throttle.force({
          kind: 'table-start',
          table,
          entitiesRendered: 0,
          entitiesTotal,
          tableIndex,
          tableCount,
          pct: 0,
        });

        const manifestEntry: EntityContextManifestEntry = {
          directoryRoot,
          ...(def.index ? { indexFile: def.index.outputFile } : {}),
          declaredFiles: Object.keys(def.files),
          protectedFiles: def.protectedFiles ?? [],
          entities: {},
        };

        // --- index file ---
        if (def.index) {
          const indexPath = join(outputDir, def.index.outputFile);
          if (atomicWrite(indexPath, def.index.render(allRows))) {
            filesWritten.push(indexPath);
          } else {
            counters.skipped++;
          }
        }

        // --- per-entity files ---
        for (let i = 0; i < allRows.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const entityRow = allRows[i]!;

          // Bail mid-table if aborted, before doing any more work for this row.
          if (signal?.aborted) return null;

          // Yield to the event loop periodically. SQLite queries resolve
          // synchronously, so without this a large render starves the HTTP
          // server (delaying abort) and freezes the GUI. Cheap and infrequent.
          if (i > 0 && i % YIELD_EVERY_ENTITIES === 0) {
            await new Promise((r) => setImmediate(r));
          }

          // Sanitize slug: replace non-ASCII whitespace (e.g., macOS narrow no-break space
          // U+202F in screenshot filenames) with regular space, strip control characters.
          const rawSlug = def.slug(entityRow);
          const slug = rawSlug
            .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001F\u007F]/g, '');

          // Validate slug against path traversal
          if (/[^a-zA-Z0-9.\-_ @(),#&'+:;!~[\]]/.test(slug)) {
            throw new Error(`Invalid slug "${slug}": contains characters outside the allowed set`);
          }

          const entityDir = def.directory
            ? join(outputDir, def.directory(entityRow))
            : join(outputDir, directoryRoot, slug);

          // Verify the resolved path stays within outputDir
          const resolvedDir = resolve(entityDir);
          const resolvedBase = resolve(outputDir);
          if (!resolvedDir.startsWith(resolvedBase + sep) && resolvedDir !== resolvedBase) {
            throw new Error(`Path traversal detected: slug "${slug}" escapes output directory`);
          }

          mkdirSync(entityDir, { recursive: true });

          // Attach the file referenced by attachFileColumn into the entity dir.
          // Default mode copies the bytes (v0.18.3+); 'reference' mode indexes
          // the file in place by writing a small pointer instead of copying.
          if (def.attachFileColumn) {
            const filePath = entityRow[def.attachFileColumn] as string | undefined;
            if (filePath && typeof filePath === 'string' && filePath.length > 0) {
              if (def.attachFileMode === 'reference') {
                // No copy: write `<name>.ref.md` pointing at the durable location
                // (works for local paths and cloud URLs alike).
                const refPath = join(entityDir, `${basename(filePath)}.ref.md`);
                // A write failure (disk space, permission) propagates out of
                // render() — never swallowed — so the manifest is not committed
                // over a tree with a missing attachment. The error is re-raised
                // and the prior manifest stays the record.
                if (atomicWrite(refPath, `# Reference\n\n- **location:** ${filePath}\n`)) {
                  filesWritten.push(refPath);
                }
              } else {
                const absPath = isAbsolute(filePath) ? filePath : resolve(outputDir, filePath);
                if (existsSync(absPath)) {
                  const destPath = join(entityDir, basename(absPath));
                  if (!existsSync(destPath)) {
                    // A copy failure (disk space, permission) propagates out of
                    // render() — never swallowed — so the manifest is not
                    // committed over a tree with a missing binary attachment.
                    copyFileSync(absPath, destPath);
                    filesWritten.push(destPath);
                  }
                }
              }
            }
          }

          // Track rendered content strings in definition order.
          // Used for combined file assembly without disk re-reads.
          // Only entries for files that were not omitted are present.
          const renderedFiles = new Map<string, string>();

          // v2 manifest: track per-file hashes
          const entityFileHashes: Record<string, EntityFileManifestInfo> = {};
          // Capture the source row's version ONCE per entity so reverse-sync can
          // detect a concurrent DB change before applying a file edit (per-file
          // info carries it; the row is the same for every file of the entity).
          const rowVersion = rowVersionHash(entityRow);

          const protection: ProtectionContext | undefined =
            protectedTables.size > 0 ? { protectedTables, currentTable: table } : undefined;

          for (const [filename, spec] of Object.entries(def.files)) {
            // Bail before each file's source query: an entity with many files would
            // otherwise keep issuing DB queries for the whole row after an abort
            // (e.g. a workspace switch), delaying teardown and wasting egress.
            if (signal?.aborted) return null;
            const mergeDefaults =
              def.sourceDefaults &&
              spec.source.type !== 'self' &&
              spec.source.type !== 'custom' &&
              spec.source.type !== 'enriched';
            const source = mergeDefaults ? { ...def.sourceDefaults, ...spec.source } : spec.source;
            // Safe-subset belongsTo: serve from the per-table batched prefetch
            // (one `WHERE pk IN (...)` already issued). Normalize the FK with the
            // SAME `String(v)` coercion used when filling the map, so the Map's
            // SameValueZero lookup matches SQL's `=`. A null FK or a missing key
            // ⇒ `[]`, exactly the per-row belongsTo result. Anything outside the
            // safe subset falls through to the unchanged per-row resolver.
            const batchable = this._batchableBelongsTo(source, protectedTables);
            let rows: Row[];
            if (batchable) {
              const byKey = belongsToBatches.get(this._belongsToBatchKey(batchable));
              const fkVal = entityRow[batchable.foreignKey];
              const hit =
                fkVal == null || !isScalarKey(fkVal)
                  ? undefined
                  : byKey?.get(RenderEngine._normKey(fkVal));
              rows = hit ? [hit] : [];
            } else {
              rows = await resolveEntitySource(
                source,
                entityRow,
                entityPk,
                this._adapter,
                protection,
              );
            }

            if (spec.omitIfEmpty && rows.length === 0) continue;

            const renderFn = compileEntityRender(spec.render);
            const content = truncateContent(renderFn(rows), spec.budget);
            renderedFiles.set(filename, content);
            entityFileHashes[filename] = { hash: contentHash(content), rowVersion };

            const filePath = join(entityDir, filename);
            if (atomicWrite(filePath, content)) {
              filesWritten.push(filePath);
            } else {
              counters.skipped++;
            }
          }

          // --- combined file ---
          // Default behavior: when an entity has multiple rendered files, the first
          // declared file (e.g., PROJECT.md, AGENT.md) becomes the combined output
          // containing all connected context. This can be overridden or disabled
          // via explicit `combined` config.
          const fileKeys = Object.keys(def.files);
          const effectiveCombined =
            def.combined ??
            (fileKeys.length > 1 && renderedFiles.size > 1
              ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                { outputFile: fileKeys[0]! }
              : undefined);
          if (effectiveCombined && renderedFiles.size > 0) {
            const excluded = new Set(effectiveCombined.exclude ?? []);
            const parts: string[] = [];

            for (const filename of Object.keys(def.files)) {
              if (!excluded.has(filename) && renderedFiles.has(filename)) {
                parts.push(renderedFiles.get(filename) ?? '');
              }
            }

            if (parts.length > 0) {
              const combinedContent = parts.join('\n\n---\n\n');
              const combinedPath = join(entityDir, effectiveCombined.outputFile);
              if (atomicWrite(combinedPath, combinedContent)) {
                filesWritten.push(combinedPath);
              } else {
                counters.skipped++;
              }
              renderedFiles.set(effectiveCombined.outputFile, combinedContent);
              entityFileHashes[effectiveCombined.outputFile] = {
                hash: contentHash(combinedContent),
                rowVersion,
              };
            }
          }

          // Track what was written for this entity in the manifest (v2: with hashes)
          manifestEntry.entities[slug] = entityFileHashes;

          // Per-entity progress, coalesced by the throttle to ≤ ~5/sec per table.
          const entitiesRendered = i + 1;
          throttle.tick({
            kind: 'table-progress',
            table,
            entitiesRendered,
            entitiesTotal,
            tableIndex,
            tableCount,
            pct: entitiesTotal > 0 ? (entitiesRendered / entitiesTotal) * 100 : 100,
          });
        }

        throttle.force({
          kind: 'table-done',
          table,
          entitiesRendered: entitiesTotal,
          entitiesTotal,
          tableIndex,
          tableCount,
          pct: 100,
        });
        return manifestEntry;
      },
    );

    // A mid-flight abort leaves some entries null — discard the whole partial tree.
    if (signal?.aborted) return null;
    const manifestData: Record<string, EntityContextManifestEntry> = {};
    for (let i = 0; i < renderedEntries.length; i++) {
      const entry = renderedEntries[i];
      if (entry == null) return null;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      manifestData[entityTables[i]![0]] = entry;
    }
    return manifestData;
  }
}
