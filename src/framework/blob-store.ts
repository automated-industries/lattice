import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Metadata for a blob written into the content-addressed store under
 * `<lattice-root>/data/blobs/<sha256>`.
 */
export interface BlobMetadata {
  sha256: string;
  /** Path relative to `<lattice-root>` (e.g. `data/blobs/abc123...`). */
  blob_path: string;
  size_bytes: number;
  original_name: string;
}

/**
 * Hash a file's contents with SHA-256, returning the hex digest. Streams
 * the file so large blobs don't have to fit in memory.
 */
export async function hashFile(srcPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(srcPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Copy a file into the lattice's content-addressed blob store at
 * `<latticeRoot>/data/blobs/<sha256>`. Idempotent — if a blob with the
 * same hash is already present, the copy is skipped.
 *
 * Returns metadata suitable for inserting into the native `files` table:
 * `{ sha256, blob_path, size_bytes, original_name }`.
 *
 * `latticeRoot` is the directory containing the lattice's `data/` tree
 * — typically the same directory as `lattice.config.yml`. The blob path
 * returned is relative to that root, so it stays stable across machines
 * even though the absolute path will differ.
 */
export async function attachBlob(srcPath: string, latticeRoot: string): Promise<BlobMetadata> {
  const stats = statSync(srcPath);
  if (!stats.isFile()) {
    throw new Error(`attachBlob: ${srcPath} is not a regular file`);
  }
  const sha256 = await hashFile(srcPath);
  const relDir = join('data', 'blobs');
  const blobDir = join(latticeRoot, relDir);
  mkdirSync(blobDir, { recursive: true });
  const destAbs = join(blobDir, sha256);
  if (!existsSync(destAbs)) {
    copyFileSync(srcPath, destAbs);
  }
  return {
    sha256,
    blob_path: join(relDir, sha256),
    size_bytes: stats.size,
    original_name: basename(srcPath),
  };
}
