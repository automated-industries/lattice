import { join } from 'node:path';
import { existsSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import type { LatticeManifest } from './manifest.js';
import { entityFileNames } from './manifest.js';
import type { EntityContextDefinition } from '../schema/entity-context.js';

export interface CleanupOptions {
  /** Remove entity directories whose slug is no longer in the DB. Default: true. */
  removeOrphanedDirectories?: boolean;
  /** Remove files inside entity dirs that are no longer declared. Default: true. */
  removeOrphanedFiles?: boolean;
  /** Additional globally protected files (merged with per-entity protectedFiles). */
  protectedFiles?: string[];
  /** Report orphans but do not delete anything. */
  dryRun?: boolean;
  /** Called for each orphan before removal (or instead of removal in dryRun mode). */
  onOrphan?: (path: string, kind: 'directory' | 'file') => void;
}

export interface CleanupResult {
  directoriesRemoved: string[];
  filesRemoved: string[];
  /** Directories with user files that were left in place. */
  directoriesSkipped: string[];
  warnings: string[];
}

/**
 * Clean up orphaned entity directories and files across all entity contexts.
 *
 * Uses the PREVIOUS manifest to determine what was managed before, and
 * currentSlugsByTable (from the current DB state) to detect orphans.
 *
 * `newManifest` is optional: when provided, step 2 (orphaned files within
 * surviving directories) compares the old manifest's files against the NEW
 * manifest's files, catching omitIfEmpty files that were written before but
 * not in the current cycle.
 *
 * Only cleans up directories/files that were in the previous manifest.
 * Custom `directory()` entity contexts are skipped for directory cleanup
 * since their paths cannot be derived from slug alone.
 */
export function cleanupEntityContexts(
  outputDir: string,
  entityContexts: Map<string, EntityContextDefinition>,
  currentSlugsByTable: Map<string, Set<string>>,
  manifest: LatticeManifest | null,
  options: CleanupOptions = {},
  newManifest?: LatticeManifest | null,
): CleanupResult {
  const result: CleanupResult = {
    directoriesRemoved: [],
    filesRemoved: [],
    directoriesSkipped: [],
    warnings: [],
  };

  if (manifest === null) return result;

  for (const [table, def] of entityContexts) {
    const entry = manifest.entityContexts[table];
    if (!entry) continue;

    const directoryRoot = entry.directoryRoot;
    const currentSlugs = currentSlugsByTable.get(table) ?? new Set<string>();
    const globalProtected = new Set([
      ...(def.protectedFiles ?? []),
      ...(options.protectedFiles ?? []),
    ]);

    const rootPath = join(outputDir, directoryRoot);
    if (!existsSync(rootPath)) continue;

    // === Step 1: Remove orphaned entity directories ===
    // Only applies to entities NOT using custom directory() — since custom paths
    // can't be derived from slug alone, directory-level cleanup is skipped for them.
    if (options.removeOrphanedDirectories !== false && !def.directory) {
      let actualDirs: string[];
      try {
        actualDirs = readdirSync(rootPath).filter((name) => {
          try {
            return statSync(join(rootPath, name)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        actualDirs = [];
      }

      for (const dirName of actualDirs) {
        if (currentSlugs.has(dirName)) continue;
        // Only remove directories that were in the previous manifest
        if (!Object.prototype.hasOwnProperty.call(entry.entities, dirName)) continue;

        const entityDir = join(rootPath, dirName);
        const managedFiles = entityFileNames(entry.entities[dirName] ?? []);

        // Remove Lattice-managed files from the orphaned directory
        for (const filename of managedFiles) {
          if (globalProtected.has(filename)) continue;
          const filePath = join(entityDir, filename);
          if (!existsSync(filePath)) continue;
          if (!options.dryRun) unlinkSync(filePath);
          options.onOrphan?.(filePath, 'file');
          result.filesRemoved.push(filePath);
        }

        // Remove directory only if now empty (no user files remain).
        // "User files" = anything currently on disk in the directory.
        // Protected files count as user files — they prevent directory removal.
        let remaining: string[];
        try {
          remaining = existsSync(entityDir) ? readdirSync(entityDir) : [];
        } catch {
          remaining = [];
        }

        if (remaining.length === 0) {
          if (!options.dryRun) {
            try { rmdirSync(entityDir); } catch { /* best-effort */ }
          }
          options.onOrphan?.(entityDir, 'directory');
          result.directoriesRemoved.push(entityDir);
        } else {
          result.directoriesSkipped.push(entityDir);
          result.warnings.push(
            `${entityDir}: left in place (contains user files: ${remaining.join(', ')})`,
          );
        }
      }
    }

    // === Step 2: Remove orphaned files within surviving entity directories ===
    // Uses directoryRoot/slug for path (custom directory() not supported here).
    if (options.removeOrphanedFiles !== false) {
      // When a new manifest is available, compare old vs new to catch omitIfEmpty
      // files that were written in the previous cycle but not this one.
      // Fall back to declaredFiles-based check when no new manifest is available.
      const newEntry = newManifest?.entityContexts[table];

      const declaredFiles = new Set(Object.keys(def.files));
      if (def.combined) declaredFiles.add(def.combined.outputFile);

      for (const slug of currentSlugs) {
        const entityDir = def.directory
          ? null  // Can't resolve path without the row — skip
          : join(rootPath, slug);
        if (!entityDir || !existsSync(entityDir)) continue;

        const previouslyWritten = entityFileNames(entry.entities[slug] ?? []);
        const currentlyWritten = new Set(entityFileNames(newEntry?.entities[slug] ?? []));

        for (const filename of previouslyWritten) {
          // Skip if still written in the new manifest (when available)
          if (newEntry !== undefined) {
            if (currentlyWritten.has(filename)) continue;
          } else {
            // Fallback: skip if still declared (handles removed-from-definition case)
            if (declaredFiles.has(filename)) continue;
          }

          if (globalProtected.has(filename)) continue;

          const filePath = join(entityDir, filename);
          if (!existsSync(filePath)) continue;
          if (!options.dryRun) unlinkSync(filePath);
          options.onOrphan?.(filePath, 'file');
          result.filesRemoved.push(filePath);
        }
      }
    }
  }

  return result;
}
