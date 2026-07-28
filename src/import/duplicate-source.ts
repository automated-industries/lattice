import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { getAsyncOrSync } from '../db/adapter.js';
import type { Lattice } from '../lattice.js';

/**
 * "Have I already got these exact bytes?" — asked BEFORE an import does any
 * work.
 *
 * Re-adding a file that is already in the workspace used to re-run the whole
 * importer first and only afterwards notice the duplicate, so the second drop
 * re-imported the data (a second snapshot, a second set of proposals) before the
 * dedup pass merged the file rows. Checking content identity up front makes the
 * order match what the user means: an identical file is the SAME file, and the
 * right amount of importing to do for it is none.
 *
 * The check is bounded — a single indexed lookup with LIMIT 1, and the hash is
 * streamed rather than buffering the file — so it is safe on the ingest hot path.
 */

export interface DuplicateSourceCheck {
  /**
   * False when this workspace has nothing to match content on (no files table,
   * or a schema without the content-hash column). The caller must treat that as
   * "cannot tell", never as "not a duplicate that we verified".
   */
  available: boolean;
  /** The source's content hash, or null when the check could not run. */
  sha256: string | null;
  /** Id of the existing row holding identical bytes, or null when there is none. */
  duplicateOfFileId: string | null;
}

/** Stream a file's SHA-256 without holding its bytes in memory. */
export async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

interface IdRow {
  id: string;
}

/**
 * Look for an active row in `table` whose content hash matches `sha256`.
 * Returns null when there is none; reports unavailability separately rather
 * than collapsing "no match" and "could not look" into one answer.
 */
export async function checkSourceIsDuplicate(
  db: Lattice,
  abs: string,
  opts: { table?: string } = {},
): Promise<DuplicateSourceCheck> {
  const table = opts.table ?? 'files';
  const columns = db.getRegisteredColumns(table);
  if (!columns || !('sha256' in columns)) {
    // Not an error: a workspace whose files table predates content hashing has
    // nothing to compare. Reported so the caller can say "not checked" instead
    // of implying the file is new.
    return { available: false, sha256: null, duplicateOfFileId: null };
  }
  const sha256 = await hashFile(abs);
  const activeOnly = 'deleted_at' in columns ? ' AND "deleted_at" IS NULL' : '';
  const row = (await getAsyncOrSync(
    db.adapter,
    `SELECT "id" FROM "${table}" WHERE "sha256" = ?${activeOnly} LIMIT 1`,
    [sha256],
  )) as IdRow | undefined;
  return { available: true, sha256, duplicateOfFileId: row?.id ?? null };
}
