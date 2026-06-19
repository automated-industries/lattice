import {
  writeFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Write content to path atomically (tmp + rename, fallback to copy for cross-device). Returns true if file was written. */
export function atomicWrite(filePath: string, content: string): boolean {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const currentHash = existingHash(filePath);
  const newHash = contentHash(content);

  if (currentHash === newHash) return false;

  const tmp = join(tmpdir(), `lattice-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (err: unknown) {
    // EXDEV: cross-device link — tmp and target are on different filesystems
    // (e.g. Docker volume mounts). Fall back to copy + unlink.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      copyFileSync(tmp, filePath);
      unlinkSync(tmp);
    } else {
      throw err;
    }
  }
  return true;
}

/**
 * Probe that a directory is writable by creating it (recursively) and then
 * writing + deleting a uniquely-named sentinel file INSIDE it. The sentinel is
 * written in the target directory on purpose — that is what catches an
 * output-volume disk-full (ENOSPC) or read-only mount (EROFS/EACCES) that
 * atomicWrite would otherwise only hit at the final rename, after live files
 * have already been touched. Throws the underlying errno error on failure.
 */
export function probeDirWritable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.lattice-probe-${randomBytes(8).toString('hex')}`);
  writeFileSync(probe, '', 'utf8');
  unlinkSync(probe);
}

function existingHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return contentHash(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * SHA-256 of an entity row's content, for optimistic-concurrency detection.
 * Serializes ALL columns in key-sorted order (column order irrelevant), so any
 * value change produces a different digest. Computed identically at render time
 * (captured in the manifest) and at reverse-sync time (compared) — a mismatch
 * means the row changed since render. Conservative by design: a change to ANY
 * column flags a conflict, which is safe (the reverse-sync edit is rejected,
 * never overwriting) even when the edit touched a different field.
 */
export function rowVersionHash(row: Record<string, unknown>): string {
  // null/undefined collapse so an absent column and an explicit null hash alike.
  const canonical = JSON.stringify(
    Object.keys(row)
      .sort()
      .map((k) => [k, row[k] ?? null]),
  );
  return contentHash(canonical);
}
