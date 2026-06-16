import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revealTargetFor } from '../../src/gui/files-routes.js';

/**
 * Regression — "Open in Finder" revealed the content-addressed blob
 * (data/blobs/<sha256> — hash name, no extension), so Finder showed a generic
 * "Document" instead of the user's image. revealTargetFor must materialize a
 * NAMED copy of the blob (with the original name + extension) and point Finder at
 * that, while leaving a real named original (local_ref) untouched.
 */
type RowArg = Parameters<typeof revealTargetFor>[0];
const make = (r: Record<string, unknown>): RowArg => r as unknown as RowArg;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'lat-finder-'));
  dirs.push(d);
  return join(d, '.lattice');
}

describe('revealTargetFor (open-in-finder shows the image, not the blob)', () => {
  it('reveals a NAMED copy of a blob — original name, real bytes, under data/finder/<id>', () => {
    const latticeRoot = freshRoot();
    const blobsDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobsDir, { recursive: true });
    const blob = join(blobsDir, 'e189284decbdf25dfc470d33aa1008fa');
    writeFileSync(blob, 'PNG-BYTES');
    const row = make({
      ref_kind: 'blob',
      original_name: 'Screenshot 2026-06-14.png',
      mime: 'image/png',
    });

    const target = revealTargetFor(row, latticeRoot, blob, 'file-1');

    expect(target).not.toBe(blob); // not the hash blob
    expect(target.endsWith('Screenshot 2026-06-14.png')).toBe(true);
    expect(target).toContain(join('data', 'finder', 'file-1'));
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('PNG-BYTES'); // same bytes as the blob
  });

  it('adds an extension from the mime when the original name has none', () => {
    const latticeRoot = freshRoot();
    const blobsDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobsDir, { recursive: true });
    const blob = join(blobsDir, 'abc123');
    writeFileSync(blob, 'x');
    const row = make({ ref_kind: 'blob', original_name: 'logo', mime: 'image/png' });
    expect(revealTargetFor(row, latticeRoot, blob, 'f2').endsWith('logo.png')).toBe(true);
  });

  it('re-reveal is idempotent (reuses the existing named copy)', () => {
    const latticeRoot = freshRoot();
    const blobsDir = join(latticeRoot, 'data', 'blobs');
    mkdirSync(blobsDir, { recursive: true });
    const blob = join(blobsDir, 'dedup');
    writeFileSync(blob, 'same');
    const row = make({ ref_kind: 'blob', original_name: 'doc.pdf', mime: 'application/pdf' });
    const a = revealTargetFor(row, latticeRoot, blob, 'f3');
    const b = revealTargetFor(row, latticeRoot, blob, 'f3');
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });

  it('reveals a local_ref original as-is (already a real, named file)', () => {
    const latticeRoot = freshRoot();
    const orig = '/Users/somebody/Pictures/my photo.jpg';
    const row = make({ ref_kind: 'local_ref', ref_uri: orig, original_name: 'my photo.jpg' });
    expect(revealTargetFor(row, latticeRoot, orig, 'f4')).toBe(orig);
  });

  it('reveals a legacy path original as-is', () => {
    const latticeRoot = freshRoot();
    const orig = '/data/legacy/file.txt';
    const row = make({ path: orig, original_name: 'file.txt' });
    expect(revealTargetFor(row, latticeRoot, orig, 'f5')).toBe(orig);
  });

  it('falls back to the blob path when there is no latticeRoot', () => {
    const row = make({ ref_kind: 'blob', original_name: 'a.png', mime: 'image/png' });
    expect(revealTargetFor(row, undefined, '/x/blobs/zzz', 'f6')).toBe('/x/blobs/zzz');
  });
});
