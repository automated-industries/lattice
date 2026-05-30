/**
 * Unified source model: a `files` row is resolved to a {@link SourceHandle}
 * regardless of whether its bytes are an owned blob, a referenced local file,
 * or a referenced cloud URL. Every caller works through the same handle, so
 * local and cloud sources share one set of utilities.
 */

export type RefKind = 'blob' | 'local_ref' | 'cloud_ref';
export type RefProvider = 'fs' | 'web' | 'gdrive';

/** The subset of a `files` row the resolver reads. */
export interface FilesRow {
  id?: string;
  ref_kind?: string | null;
  ref_uri?: string | null;
  ref_provider?: string | null;
  blob_path?: string | null;
  path?: string | null;
  original_name?: string | null;
  mime?: string | null;
  size_bytes?: number | null;
  source_json?: string | null;
  [key: string]: unknown;
}

export interface SourceMetadata {
  /** False when the underlying file/URL is gone or unreachable. */
  available: boolean;
  size_bytes?: number;
  mime?: string;
  original_name?: string;
  modified_at?: string;
  /** Provider-specific extras, folded into the row's `source_json`. */
  extra?: Record<string, unknown>;
}

export interface SourceHandle {
  kind: RefKind;
  provider: RefProvider;
  /** Durable, human/AI-findable location: an absolute path, a URL, or `blob:<sha256>`. */
  location: string;
  /** Read the underlying bytes. Throws {@link ReferenceUnavailableError} if gone. */
  readContent(): Promise<Buffer>;
  /** Cheap metadata probe — no full read. */
  getMetadata(): Promise<SourceMetadata>;
}

/** Optional injection points (test seams / host-supplied fetch). */
export interface ResolveOptions {
  /** Override the fetch implementation used by web/gdrive providers. */
  fetcher?: typeof fetch;
  /** Allow fetching private/loopback addresses (default false — SSRF guard on). */
  allowPrivate?: boolean;
  /** Cap bytes read from a remote source (default 25 MB). */
  maxBytes?: number;
}

export class ReferenceUnavailableError extends Error {
  constructor(location: string, reason: string) {
    super(`Lattice: source unavailable (${location}): ${reason}`);
    this.name = 'ReferenceUnavailableError';
  }
}
