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
}

export interface EntityContextManifestEntry {
  directoryRoot: string;
  indexFile?: string;
  declaredFiles: string[];
  protectedFiles: string[];
  /**
   * Key = entity slug.
   *
   * **v2 format:** value is `Record<string, EntityFileManifestInfo>` (filename → info with hash).
   * **v1 format (legacy):** value is `string[]` (bare filename list, no hashes).
   *
   * Use {@link normalizeEntityFiles} to convert v1 entries.
   */
  entities: Record<string, Record<string, EntityFileManifestInfo> | string[]>;
}

export interface LatticeManifest {
  version: 1 | 2;
  generated_at: string;
  entityContexts: Record<string, EntityContextManifestEntry>;
}

// ---------------------------------------------------------------------------
// v1 → v2 helpers
// ---------------------------------------------------------------------------

/** Type guard: is the entity files entry in v1 format (string[])? */
export function isV1EntityFiles(val: unknown): val is string[] {
  return Array.isArray(val);
}

/**
 * Convert a v1 entity files entry (string[]) to v2 format (Record with empty hashes).
 * Reverse-sync skips entries with empty hashes (no baseline to compare against).
 */
export function normalizeEntityFiles(
  val: Record<string, EntityFileManifestInfo> | string[],
): Record<string, EntityFileManifestInfo> {
  if (!Array.isArray(val)) return val;
  const result: Record<string, EntityFileManifestInfo> = {};
  for (const f of val) result[f] = { hash: '' };
  return result;
}

/**
 * Get the filenames from an entity files entry (works for both v1 and v2).
 */
export function entityFileNames(val: Record<string, EntityFileManifestInfo> | string[]): string[] {
  return Array.isArray(val) ? val : Object.keys(val);
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
