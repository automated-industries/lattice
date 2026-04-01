import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Write content to path atomically (tmp + rename). Returns true if file was written. */
export function atomicWrite(filePath: string, content: string): boolean {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const currentHash = existingHash(filePath);
  const newHash = contentHash(content);

  if (currentHash === newHash) return false;

  const tmp = join(tmpdir(), `lattice-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
  return true;
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
