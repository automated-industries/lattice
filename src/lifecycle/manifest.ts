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

/**
 * Render-output FORMAT version. Bump this — and ONLY this — when a change to the
 * render engine alters the BYTES a clean render would produce for unchanged data
 * (a template tweak, a new combined-file rule, a slug-sanitization change, …).
 *
 * It is deliberately NOT the npm package version: a plain version bump that does
 * not change render output must NOT invalidate an existing tree (re-rendering an
 * identical tree on every upgrade is the churn this gate exists to stop). The
 * open-time staleness gate treats a manifest whose `templateVersion` differs from
 * this constant as STALE and forces a full render — so an output-format change is
 * guaranteed to reach disk on the next open.
 */
export const TEMPLATE_VERSION = 1;

/**
 * Monotonic cursor the rendered tree was produced FROM, recorded in the manifest
 * so a later open can decide whether anything the tree depends on has advanced.
 *
 * Each field is a string-comparable high-water mark (or `null` when the substrate
 * is absent / unreadable in the current scope). Computed THROUGH the same DB
 * connection + read scope the render used, so for a cloud MEMBER each mark
 * reflects only what that member can see — making the cursor a per-viewer
 * freshness key, not a global one.
 *
 * - `changelog` — the write log's high-water mark. Captures plain data edits AND
 *   the per-viewer DERIVED observations a member's tree folds in (both are
 *   changelog rows), so a new observation advances it even though no entity row's
 *   count moved.
 * - `grants` / `owners` — the row-sharing graph's high-water mark. A share or
 *   un-share changes a member's visible row set without touching any entity row,
 *   so these capture that class of change. For a member they are derived from the
 *   member-visible change feed (the only share signal a member may read); for an
 *   owner / local DB they come from the ownership + grant bookkeeping directly.
 */
export interface RenderCursor {
  changelog: string | null;
  grants: string | null;
  owners: string | null;
}

export interface LatticeManifest {
  version: 1 | 2;
  generated_at: string;
  entityContexts: Record<string, EntityContextManifestEntry>;
  /**
   * Render-output format version the tree was produced with (see
   * {@link TEMPLATE_VERSION}). Optional: a manifest written before this field
   * existed reads as `undefined`, which the staleness gate treats as a mismatch
   * → full render (fail-open). Set on every render that writes a manifest.
   */
  templateVersion?: number;
  /**
   * The cursor the tree was rendered from (see {@link RenderCursor}). Optional for
   * the same backward-compat reason; absence → the gate fails open and renders.
   * On an INCREMENTAL render this is recomputed from the live DB (a single
   * top-level cursor reflecting the latest computation), NOT merged per-table — so
   * it always advances to the newest state the partial render observed.
   */
  cursor?: RenderCursor;
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
