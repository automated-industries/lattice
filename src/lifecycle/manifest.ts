import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from '../render/writer.js';

// ---------------------------------------------------------------------------
// Manifest v2 — adds per-file content hashes for reverse-sync
// ---------------------------------------------------------------------------

/**
 * Per-file tracking info stored in the manifest.
 * Includes the SHA-256 hash of the last-rendered content.
 */
export interface EntityFileManifestInfo {
  /** SHA-256 hex digest of the rendered content. */
  hash: string;
  /**
   * SHA-256 of the source entity row at render time (all columns, key-sorted).
   * Reverse-sync compares this against the row's CURRENT version before applying
   * a file edit: a mismatch means the DB row changed since this render, so the
   * edit is rejected as a conflict instead of silently overwriting it. Optional
   * for back-compat — manifests written before this field fall back to applying
   * (the prior behavior) until the next render re-captures it.
   */
  rowVersion?: string;
}

export interface EntityContextManifestEntry {
  directoryRoot: string;
  indexFile?: string;
  declaredFiles: string[];
  protectedFiles: string[];
  /**
   * Key = entity slug. Value = `Record<string, EntityFileManifestInfo>`
   * (filename → info with content hash). This is the only shape we WRITE.
   */
  entities: Record<string, Record<string, EntityFileManifestInfo>>;
}

export interface LatticeManifest {
  version: 1 | 2;
  generated_at: string;
  entityContexts: Record<string, EntityContextManifestEntry>;
}

// ---------------------------------------------------------------------------
// Entity files accessor
// ---------------------------------------------------------------------------

/**
 * Get the filenames from an entity files entry.
 *
 * We only ever WRITE the v2 `Record<filename, info>` shape, but an OLD manifest
 * already on disk may still carry a bare `string[]` entry (the pre-hash format).
 * This accessor tolerates that legacy shape at the read boundary — a stale
 * manifest is upgraded silently on the next render, never crashed over — and
 * still returns the filenames so cleanup can detect orphaned files for it.
 */
export function entityFileNames(
  val: Record<string, EntityFileManifestInfo> | readonly string[],
): string[] {
  if (Array.isArray(val)) return (val as readonly string[]).slice();
  return Object.keys(val);
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

export function manifestPath(outputDir: string): string {
  return join(outputDir, '.lattice', 'manifest.json');
}

export function readManifest(outputDir: string): LatticeManifest | null {
  const path = manifestPath(outputDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LatticeManifest;
  } catch {
    return null;
  }
}

export function writeManifest(outputDir: string, manifest: LatticeManifest): void {
  atomicWrite(manifestPath(outputDir), JSON.stringify(manifest, null, 2));
}
