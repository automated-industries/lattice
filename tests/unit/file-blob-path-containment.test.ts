import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPathOf, type FileRow } from '../../src/gui/files-routes.js';

/**
 * Regression (S1, read side): `localPathOf` must never resolve to a path OUTSIDE the workspace
 * for a content-addressed blob, and must not serve a user-linked local file when local file open
 * is disabled (team cloud). A crafted `blob_path` (`../../etc/passwd`, an absolute path) or a
 * `local_ref` on a hosted tenant used to stream arbitrary host files (e.g. /proc/self/environ).
 */
describe('localPathOf — blob path containment + local_ref cloud gate (S1)', () => {
  const dirs: string[] = [];
  let root: string;
  let savedLocalOpen: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lattice-blob-'));
    dirs.push(root);
    mkdirSync(join(root, 'data', 'blobs'), { recursive: true });
    writeFileSync(join(root, 'data', 'blobs', 'abc123'), 'blob bytes'); // a legit content-addressed blob
    savedLocalOpen = process.env.LATTICE_LOCAL_OPEN;
  });
  afterEach(() => {
    if (savedLocalOpen === undefined) delete process.env.LATTICE_LOCAL_OPEN;
    else process.env.LATTICE_LOCAL_OPEN = savedLocalOpen;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('resolves a legitimate in-workspace blob', () => {
    const row: FileRow = { ref_kind: 'blob', blob_path: 'data/blobs/abc123' };
    expect(localPathOf(row, root)).toBe(join(root, 'data', 'blobs', 'abc123'));
  });

  it('refuses a blob_path that escapes the workspace via ../', () => {
    // Point at a real file well outside the root so realpath resolves — it must still be refused.
    const outside = mkdtempSync(join(tmpdir(), 'lattice-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    const rel = join('..', '..', '..', '..', '..', '..', outside.replace(/^\/+/, ''), 'secret.txt');
    const row: FileRow = { ref_kind: 'blob', blob_path: rel };
    expect(localPathOf(row, root)).toBeNull();
  });

  it('refuses an ABSOLUTE blob_path pointing outside the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'lattice-outside-'));
    dirs.push(outside);
    const secret = join(outside, 'passwd');
    writeFileSync(secret, 'root:x:0:0');
    const row: FileRow = { ref_kind: 'blob', blob_path: secret };
    expect(localPathOf(row, root)).toBeNull();
  });

  it('serves a local_ref only when local file open is enabled (desktop/CLI)', () => {
    const linked = join(dirs[0]!, 'linked.txt');
    writeFileSync(linked, 'a file the user linked');
    const row: FileRow = { ref_kind: 'local_ref', ref_uri: linked };

    delete process.env.LATTICE_LOCAL_OPEN; // default: enabled
    expect(localPathOf(row, root)).toBe(linked);

    process.env.LATTICE_LOCAL_OPEN = '0'; // team cloud: disabled
    expect(localPathOf(row, root)).toBeNull();
  });

  it('a hosted tenant (local open OFF) cannot read /etc/passwd via a crafted local_ref', () => {
    process.env.LATTICE_LOCAL_OPEN = '0';
    const row: FileRow = { ref_kind: 'local_ref', ref_uri: '/etc/passwd' };
    expect(localPathOf(row, root)).toBeNull();
  });
});
