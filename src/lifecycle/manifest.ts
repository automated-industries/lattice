import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from '../render/writer.js';

export interface LatticeManifest {
  version: 1;
  generated_at: string;
  entityContexts: Record<string, EntityContextManifestEntry>;
}

export interface EntityContextManifestEntry {
  directoryRoot: string;
  indexFile?: string;
  declaredFiles: string[];
  protectedFiles: string[];
  /** Key = slug, value = filenames actually written (omitIfEmpty files may be absent) */
  entities: Record<string, string[]>;
}

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
