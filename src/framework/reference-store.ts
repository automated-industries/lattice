import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RefProvider } from '../sources/types.js';
import { assertSafeUrl, providerForUrl } from '../sources/url-safety.js';

/**
 * Reference-ingestion API — parallel to {@link attachBlob}, but records a row
 * that *indexes* data living elsewhere instead of copying bytes. The returned
 * metadata spreads straight into `db.insert('files', { id, ...meta })`.
 */
export interface ReferenceMetadata {
  ref_kind: 'local_ref' | 'cloud_ref';
  ref_uri: string;
  ref_provider: RefProvider;
  extraction_status: 'pending';
  source_json: string;
  original_name?: string;
  mime?: string;
  size_bytes?: number;
}

/**
 * Record a reference to a local file **without copying it**. The file stays
 * exactly where it is on disk; the row stores its absolute path. Marks
 * `extraction_status: 'pending'` so an extraction pass can fill `extracted_text`.
 */
export function referenceLocalFile(srcPath: string): ReferenceMetadata {
  const abs = resolve(srcPath);
  const meta: ReferenceMetadata = {
    ref_kind: 'local_ref',
    ref_uri: abs,
    ref_provider: 'fs',
    original_name: basename(abs),
    extraction_status: 'pending',
    source_json: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  };
  try {
    meta.size_bytes = statSync(abs).size;
  } catch {
    // The file may not exist yet or be unreadable — still record the reference.
  }
  return meta;
}

/**
 * Record a reference to a cloud URL (web page, Drive link, …). Validates the
 * URL against the SSRF guard but does **not** fetch — the fetch/extract happens
 * later in the extraction pass, keeping ingestion fast and crash-safe.
 */
export async function referenceUrl(
  url: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<ReferenceMetadata> {
  await assertSafeUrl(url, opts.allowPrivate ?? false);
  return {
    ref_kind: 'cloud_ref',
    ref_uri: url,
    ref_provider: providerForUrl(url),
    extraction_status: 'pending',
    source_json: JSON.stringify({ queued_at: new Date().toISOString() }),
  };
}
