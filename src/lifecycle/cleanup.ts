import { join } from 'node:path';
import { existsSync, readdirSync, unlinkSync, rmdirSync, statSync, readFileSync } from 'node:fs';
import type { LatticeManifest, EntityFileManifestInfo } from './manifest.js';
import { entityFileNames } from './manifest.js';
import { contentHash } from '../render/writer.js';
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
/**
 * The recorded render hash for one managed file, or null when the manifest entry
 * predates per-file hashes (legacy bare-array entries).
 */
function recordedHashOf(
  filesVal: Record<string, EntityFileManifestInfo> | readonly string[],
  filename: string,
): string | null {
  if (Array.isArray(filesVal)) return null;
  const info = (filesVal as Record<string, EntityFileManifestInfo>)[filename];
  // An empty hash (legacy v1 entry) is "no baseline", same as a missing entry.
  if (!info?.hash) return null;
  return info.hash;
}

/**
 * SAFE-PRUNE GUARD — the reconciliation invariant: never delete a file whose
 * on-disk content differs from Lattice's own last write. `expectedHash` null
 * (legacy manifest entry with no hash) keeps the pre-guard behavior (delete),
 * because those entries predate manual-edit tracking and blocking on them would
 * leave every legacy workspace permanently unpruned. Returns true when the file
 * was removed (or no longer exists).
 */
function guardedUnlink(
  filePath: string,
  expectedHash: string | null,
  dryRun: boolean | undefined,
  warnings: string[],
): boolean {
  if (!existsSync(filePath)) return true;
  if (expectedHash !== null) {
    let onDisk: string | null = null;
    try {
      onDisk = contentHash(readFileSync(filePath, 'utf8'));
    } catch {
      onDisk = null;
    }
    if (onDisk !== expectedHash) {
      warnings.push(
        `${filePath}: left in place — its content differs from what Lattice last ` +
          `rendered (a manual edit?). Not deleted; review or remove it yourself.`,
      );
      return false;
    }
  }
  if (!dryRun) unlinkSync(filePath);
  return true;
}

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

  // === Step 0: Remove COLLAPSED/REMOVED entity-context tables ===
  // A table the PREVIOUS manifest recorded as an entity context that is NO LONGER
  // a current entity context (e.g. a many-to-many junction that collapsed into a
  // `manyToMany` relation and was dropped from getEntityContexts()) would never be
  // visited by the per-context loop below — its whole `Context/<Table>/` tree
  // would be orphaned forever. Use the PRIOR manifest as the record of what
  // Lattice managed (per-row dirs + their managed files), so we only ever remove
  // directories Lattice created — never an unrelated top-level dir. Custom
  // `directory()` contexts are not handled here: their per-row paths can't be
  // derived from the manifest's slug keys, so they're left untouched (same
  // conservative stance as Step 1).
  if (options.removeOrphanedDirectories !== false) {
    for (const [table, entry] of Object.entries(manifest.entityContexts)) {
      // Still a current context AND still rendering to the same root → the
      // per-context Steps 1-2 handle it. A context whose directoryRoot CHANGED
      // (a rename) falls through: its PRIOR root tree is now orphaned and is
      // pruned here exactly like a collapsed context — previously a renamed
      // root left the whole old tree behind forever.
      const currentDef = entityContexts.get(table);
      const currentRoot =
        newManifest?.entityContexts[table]?.directoryRoot ?? currentDef?.directoryRoot;
      if (currentDef && currentRoot === entry.directoryRoot) continue;

      const directoryRoot = entry.directoryRoot;
      const rootPath = join(outputDir, directoryRoot);
      if (!existsSync(rootPath)) continue;

      const globalProtected = new Set(options.protectedFiles ?? []);

      // The manifest records, per slug, the files Lattice wrote into that row dir.
      for (const [slug, files] of Object.entries(entry.entities)) {
        const entityDir = join(rootPath, slug);
        if (!existsSync(entityDir)) continue;

        // Remove only the files Lattice managed for this entity.
        for (const filename of entityFileNames(files)) {
          if (globalProtected.has(filename)) continue;
          const filePath = join(entityDir, filename);
          if (!existsSync(filePath)) continue;
          if (
            !guardedUnlink(
              filePath,
              recordedHashOf(files, filename),
              options.dryRun,
              result.warnings,
            )
          ) {
            continue; // user-edited → left in place, loudly
          }
          options.onOrphan?.(filePath, 'file');
          result.filesRemoved.push(filePath);
        }

        // Remove the per-row dir only if nothing (user/protected files) remains.
        let remaining: string[];
        try {
          remaining = existsSync(entityDir) ? readdirSync(entityDir) : [];
        } catch {
          remaining = [];
        }
        if (remaining.length === 0) {
          if (!options.dryRun) {
            try {
              rmdirSync(entityDir);
            } catch {
              /* best-effort */
            }
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

      // Finally, remove the now-collapsed table's root dir if it is empty (all its
      // managed per-row dirs were removed and nothing else lives there).
      let rootRemaining: string[];
      try {
        rootRemaining = existsSync(rootPath) ? readdirSync(rootPath) : [];
      } catch {
        rootRemaining = [];
      }
      if (rootRemaining.length === 0) {
        if (!options.dryRun) {
          try {
            rmdirSync(rootPath);
          } catch {
            /* best-effort */
          }
        }
        options.onOrphan?.(rootPath, 'directory');
        result.directoriesRemoved.push(rootPath);
      }
    }
  }

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
          const expected = recordedHashOf(entry.entities[dirName] ?? [], filename);
          if (!guardedUnlink(filePath, expected, options.dryRun, result.warnings)) {
            continue; // user-edited → left in place, loudly
          }
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
            try {
              rmdirSync(entityDir);
            } catch {
              /* best-effort */
            }
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
          ? null // Can't resolve path without the row — skip
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
          const expected = recordedHashOf(entry.entities[slug] ?? [], filename);
          if (!guardedUnlink(filePath, expected, options.dryRun, result.warnings)) {
            continue; // user-edited → left in place, loudly
          }
          options.onOrphan?.(filePath, 'file');
          result.filesRemoved.push(filePath);
        }
      }
    }
  }

  // === Step 3: prune RETIRED rollup files ===
  // The manifest's retiredFiles ledger records rendered files whose path is no
  // longer produced (an outputFile change, a dropped table — e.g. a legacy
  // root-level STATES.md re-homed to .schema-only/ by the config upgrade).
  // Each is deleted ONLY when its on-disk bytes still hash to Lattice's own
  // last write; a user-edited file is left in place with a loud warning. An
  // entry persists in the ledger until its file is actually gone, so a crash
  // anywhere in this pass simply retries on the next render.
  if (options.removeOrphanedFiles !== false) {
    for (const e of newManifest?.retiredFiles ?? manifest.retiredFiles ?? []) {
      const filePath = join(outputDir, e.path);
      if (!existsSync(filePath)) continue;
      if (!guardedUnlink(filePath, e.hash, options.dryRun, result.warnings)) continue;
      options.onOrphan?.(filePath, 'file');
      result.filesRemoved.push(filePath);
    }
  }

  return result;
}
