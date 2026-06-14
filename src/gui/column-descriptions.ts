/**
 * Column definitions — one source of truth for "what does this column mean?".
 *
 * A column's description is consumed in three places:
 *   1. the GUI hover tooltip on table headers / field labels,
 *   2. the assistant's schema context (so a good description improves the
 *      model's categorization + extraction), and
 *   3. the `set_column_description` assistant tool (write-back).
 *
 * Resolution order: an operator-authored description (stored in
 * `_lattice_gui_column_meta.description`) wins; otherwise a built-in default
 * for the native entities + common system columns; otherwise none (the caller
 * falls back to the column's type/role).
 */

/** Built-in definitions for the user-facing native entities (files/notes/secrets). */
export const BUILTIN_COLUMN_DESCRIPTIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  files: {
    original_name: 'Original filename as uploaded.',
    mime: 'MIME content type of the file (e.g. application/pdf).',
    size_bytes: 'File size in bytes.',
    sha256: 'SHA-256 content hash — the canonical identifier of the stored file.',
    blob_path: "Relative path to the stored binary under the lattice data/blobs directory.",
    ref_kind: "How the file is stored: 'blob' (an owned copy), 'local_ref', or 'cloud_ref'.",
    ref_uri: 'Durable pointer to the data: absolute local path, remote URL, or s3://bucket/key.',
    ref_provider: "Resolver that fetches the data: 'fs', 'web', 'gdrive', or 's3'.",
    source_json: 'Provider-specific metadata (etag, availability, bucket/key/region…).',
    extraction_status: "State of text extraction for this file (e.g. 'extracted', 'pending').",
    extracted_text: 'Text pulled from the file contents — used for search and enrichment.',
    description: 'Short summary of what this file is (AI- or human-authored).',
    path: 'Legacy local path (deprecated — superseded by ref_kind/ref_uri).',
    kind: 'Legacy type tag (deprecated — superseded by mime/ref_kind).',
  },
  notes: {
    title: 'Short title of the note.',
    body: 'Free-form note body (markdown).',
    source_file_id: 'Id of the files row this note was derived from, if any.',
  },
  secrets: {
    name: 'Unique name/key the secret is looked up by.',
    kind: 'Category of the secret (e.g. api_key, token, password).',
    value: 'The secret value — stored encrypted at rest.',
    description: 'What this secret is for.',
  },
};

/** Definitions for the system columns shared by (almost) every entity. */
export const BUILTIN_SYSTEM_COLUMN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  id: 'Primary key — the unique identifier of this row.',
  created_at: 'When this row was created.',
  updated_at: 'When this row was last updated.',
  deleted_at: 'When this row was soft-deleted (empty while the row is active).',
};

/** Built-in description for a column, or undefined if there is none. */
export function builtinColumnDescription(table: string, column: string): string | undefined {
  return BUILTIN_COLUMN_DESCRIPTIONS[table]?.[column] ?? BUILTIN_SYSTEM_COLUMN_DESCRIPTIONS[column];
}

/**
 * Resolve a column's effective description: operator-authored value wins,
 * else the built-in default, else undefined. Trims/blank-checks the authored
 * value so an empty string clears the override back to the built-in.
 */
export function resolveColumnDescription(
  table: string,
  column: string,
  authored?: string | null,
): string | undefined {
  const a = typeof authored === 'string' ? authored.trim() : '';
  if (a) return a;
  return builtinColumnDescription(table, column);
}
