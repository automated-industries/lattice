import { join, basename, isAbsolute, resolve } from 'node:path';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import type { SchemaManager } from '../schema/manager.js';
import type { StorageAdapter } from '../db/adapter.js';
import type { RenderResult } from '../types.js';
import { atomicWrite, contentHash } from './writer.js';
import { applyTokenBudget } from './token-budget.js';
import {
  resolveEntitySource,
  truncateContent,
  batchPrefetchEntitySources,
  type ProtectionContext,
} from './entity-query.js';
import { compileEntityRender } from './entity-templates.js';
import type {
  EntityContextManifestEntry,
  LatticeManifest,
  EntityFileManifestInfo,
} from '../lifecycle/manifest.js';
import { writeManifest } from '../lifecycle/manifest.js';
import type { CleanupOptions, CleanupResult } from '../lifecycle/cleanup.js';
import { cleanupEntityContexts } from '../lifecycle/cleanup.js';

export class RenderEngine {
  private readonly _schema: SchemaManager;
  private readonly _adapter: StorageAdapter;
  private readonly _getTaskContext: () => string;

  constructor(schema: SchemaManager, adapter: StorageAdapter, getTaskContext?: () => string) {
    this._schema = schema;
    this._adapter = adapter;
    this._getTaskContext = getTaskContext ?? (() => '');
  }

  async render(outputDir: string): Promise<RenderResult> {
    const start = Date.now();
    const filesWritten: string[] = [];
    const counters = { skipped: 0 };

    // Single-table renders
    for (const [name, def] of this._schema.getTables()) {
      let rows = this._schema.queryTable(this._adapter, name);
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
              this._adapter.run(
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
    }

    // Multi-table renders
    for (const [, def] of this._schema.getMultis()) {
      const keys = await def.keys();
      const tables: Record<string, import('../types.js').Row[]> = {};

      if (def.tables) {
        for (const t of def.tables) {
          tables[t] = this._schema.queryTable(this._adapter, t);
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
    }

    // Entity context renders
    const entityContextManifest = this._renderEntityContexts(outputDir, filesWritten, counters);

    // Write manifest if there are any entity contexts
    if (this._schema.getEntityContexts().size > 0) {
      writeManifest(outputDir, {
        version: 2,
        generated_at: new Date().toISOString(),
        entityContexts: entityContextManifest,
      });
    }

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
  cleanup(
    outputDir: string,
    prevManifest: LatticeManifest | null,
    options: CleanupOptions = {},
    newManifest?: LatticeManifest | null,
  ): CleanupResult {
    const entityContexts = this._schema.getEntityContexts();
    const currentSlugsByTable = new Map<string, Set<string>>();
    for (const [table, def] of entityContexts) {
      const rows = this._schema.queryTable(this._adapter, table);
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
   * Render all entity context definitions.
   * Mutates `filesWritten` and `counters` in place.
   * Returns manifest data for the entity contexts rendered this cycle.
   */
  private _renderEntityContexts(
    outputDir: string,
    filesWritten: string[],
    counters: { skipped: number },
  ): Record<string, EntityContextManifestEntry> {
    const manifestData: Record<string, EntityContextManifestEntry> = {};

    // Build set of protected table names for source filtering
    const protectedTables = new Set<string>();
    for (const [t, d] of this._schema.getEntityContexts()) {
      if (d.protected) protectedTables.add(t);
    }

    for (const [table, def] of this._schema.getEntityContexts()) {
      const entityPk = this._schema.getPrimaryKey(table)[0] ?? 'id';
      const allRows = this._schema.queryTable(this._adapter, table);
      const directoryRoot = def.directoryRoot ?? table;

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

      // --- batch prefetch for entity sources ---
      const protection: ProtectionContext | undefined =
        protectedTables.size > 0 ? { protectedTables, currentTable: table } : undefined;

      // Merge sourceDefaults into each source before batching
      const mergedFiles: Record<
        string,
        {
          source: import('../schema/entity-context.js').EntityFileSource;
          limit?: number | undefined;
        }
      > = {};
      for (const [filename, spec] of Object.entries(def.files)) {
        const mergeDefaults =
          def.sourceDefaults &&
          spec.source.type !== 'self' &&
          spec.source.type !== 'custom' &&
          spec.source.type !== 'enriched';
        const source = mergeDefaults ? { ...def.sourceDefaults, ...spec.source } : spec.source;
        mergedFiles[filename] = { source, limit: spec.budget };
      }

      const batch = batchPrefetchEntitySources(
        mergedFiles,
        allRows,
        entityPk,
        this._adapter,
        protection,
      );

      // --- per-entity files ---
      for (const entityRow of allRows) {
        // Sanitize slug: replace non-ASCII whitespace (e.g., macOS narrow no-break space
        // U+202F in screenshot filenames) with regular space, strip control characters.
        const rawSlug = def.slug(entityRow);
        const slug = rawSlug
          .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1F\x7F]/g, '');

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
        if (!resolvedDir.startsWith(resolvedBase + '/') && resolvedDir !== resolvedBase) {
          throw new Error(`Path traversal detected: slug "${slug}" escapes output directory`);
        }

        mkdirSync(entityDir, { recursive: true });

        // Copy attached file into entity dir (v0.18.3+)
        if (def.attachFileColumn) {
          const filePath = entityRow[def.attachFileColumn] as string | undefined;
          if (filePath && typeof filePath === 'string' && filePath.length > 0) {
            const absPath = isAbsolute(filePath) ? filePath : resolve(outputDir, filePath);
            if (existsSync(absPath)) {
              const destPath = join(entityDir, basename(absPath));
              if (!existsSync(destPath)) {
                try {
                  copyFileSync(absPath, destPath);
                  filesWritten.push(destPath);
                } catch {
                  // Silently skip copy failures (permission, disk space, etc.)
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

        const rawPkVal = entityRow[entityPk] as string | number | null | undefined;
        const entityPkVal = rawPkVal != null ? String(rawPkVal) : '';

        for (const [filename, spec] of Object.entries(def.files)) {
          let rows: import('../types.js').Row[];

          if (spec.source.type === 'self') {
            rows = [entityRow];
          } else if (batch.unbatched.has(filename)) {
            // Fall back to per-entity resolution for custom/enriched/protected sources
            const merged = mergedFiles[filename];
            rows = merged
              ? resolveEntitySource(merged.source, entityRow, entityPk, this._adapter, protection)
              : [];
          } else if (batch.results.has(filename)) {
            const batchMap = batch.results.get(filename);
            rows = batchMap?.get(entityPkVal) ?? [];
          } else {
            rows = [];
          }

          if (spec.omitIfEmpty && rows.length === 0) continue;

          const renderFn = compileEntityRender(spec.render);
          const content = truncateContent(renderFn(rows), spec.budget);
          renderedFiles.set(filename, content);
          entityFileHashes[filename] = { hash: contentHash(content) };

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
            ? { outputFile: fileKeys[0] ?? '' }
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
            entityFileHashes[effectiveCombined.outputFile] = { hash: contentHash(combinedContent) };
          }
        }

        // Track what was written for this entity in the manifest (v2: with hashes)
        manifestEntry.entities[slug] = entityFileHashes;
      }

      manifestData[table] = manifestEntry;
    }

    return manifestData;
  }
}
