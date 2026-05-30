import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSource } from '../../src/sources/resolver.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-res-'));
  dirs.push(d);
  return d;
}

describe('resolveSource', () => {
  it('a NULL ref_kind resolves as an owned blob under the lattice root', async () => {
    const root = tmp();
    mkdirSync(join(root, 'data', 'blobs'), { recursive: true });
    writeFileSync(join(root, 'data', 'blobs', 'abc'), 'BYTES');
    const h = resolveSource({ blob_path: 'data/blobs/abc' }, root);
    expect(h.kind).toBe('blob');
    expect((await h.readContent()).toString()).toBe('BYTES');
    expect((await h.getMetadata()).available).toBe(true);
  });

  it('local_ref reads the file in place', async () => {
    const root = tmp();
    const f = join(root, 'note.md');
    writeFileSync(f, 'NOTE');
    const h = resolveSource({ ref_kind: 'local_ref', ref_uri: f, original_name: 'note.md' }, root);
    expect(h.kind).toBe('local_ref');
    expect(h.location).toBe(f);
    expect((await h.readContent()).toString()).toBe('NOTE');
    const md = await h.getMetadata();
    expect(md.available).toBe(true);
    expect(md.original_name).toBe('note.md');
  });

  it('local_ref reports unavailable + throws when the file is gone', async () => {
    const root = tmp();
    const h = resolveSource({ ref_kind: 'local_ref', ref_uri: join(root, 'missing.md') }, root);
    expect((await h.getMetadata()).available).toBe(false);
    await expect(h.readContent()).rejects.toThrow(/unavailable/i);
  });

  it('cloud_ref fetches via an injected fetcher (no real network)', async () => {
    const root = tmp();
    const fetcher = (() =>
      Promise.resolve(
        new Response('WEB', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      )) as unknown as typeof fetch;
    const h = resolveSource(
      { ref_kind: 'cloud_ref', ref_provider: 'web', ref_uri: 'https://example.com/x' },
      root,
      { fetcher, allowPrivate: true },
    );
    expect(h.kind).toBe('cloud_ref');
    expect(h.provider).toBe('web');
    expect((await h.readContent()).toString()).toBe('WEB');
  });
});
