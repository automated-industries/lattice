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
