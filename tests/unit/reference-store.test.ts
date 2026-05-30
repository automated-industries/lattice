import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceLocalFile, referenceUrl } from '../../src/framework/reference-store.js';
import { providerForUrl } from '../../src/sources/url-safety.js';
import { NATIVE_ENTITY_DEFS } from '../../src/framework/native-entities.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reference-store', () => {
  it('the native files table carries the reference columns', () => {
    const cols = NATIVE_ENTITY_DEFS.files?.columns ?? {};
    expect(cols).toHaveProperty('ref_kind');
    expect(cols).toHaveProperty('ref_uri');
    expect(cols).toHaveProperty('ref_provider');
    expect(cols).toHaveProperty('source_json');
  });

  it('referenceLocalFile records an absolute local_ref without copying', () => {
    const base = mkdtempSync(join(tmpdir(), 'lattice-ref-'));
    dirs.push(base);
    const f = join(base, 'doc.txt');
    writeFileSync(f, 'hello');
    const m = referenceLocalFile(f);
    expect(m.ref_kind).toBe('local_ref');
    expect(m.ref_provider).toBe('fs');
    expect(m.ref_uri).toBe(f);
    expect(m.original_name).toBe('doc.txt');
    expect(m.size_bytes).toBe(5);
    expect(m.extraction_status).toBe('pending');
    expect((m as Record<string, unknown>).blob_path).toBeUndefined();
  });

  it('providerForUrl distinguishes gdrive from web', () => {
    expect(providerForUrl('https://example.com/a.pdf')).toBe('web');
    expect(providerForUrl('https://drive.google.com/file/d/abc/view')).toBe('gdrive');
    expect(providerForUrl('https://docs.google.com/document/d/abc')).toBe('gdrive');
  });

  it('referenceUrl records a cloud_ref without fetching', async () => {
    const m = await referenceUrl('https://example.com/a.pdf', { allowPrivate: true });
    expect(m.ref_kind).toBe('cloud_ref');
    expect(m.ref_provider).toBe('web');
    expect(m.ref_uri).toBe('https://example.com/a.pdf');
    expect(m.extraction_status).toBe('pending');
  });

  it('referenceUrl enforces the SSRF guard', async () => {
    await expect(referenceUrl('ftp://example.com/x')).rejects.toThrow(/non-http/i);
    await expect(referenceUrl('http://127.0.0.1/x')).rejects.toThrow(/private/i);
    await expect(referenceUrl('http://localhost:8080/x')).rejects.toThrow(/private/i);
    await expect(referenceUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private/i,
    );
    // explicit opt-in bypasses the guard
    const ok = await referenceUrl('http://127.0.0.1/x', { allowPrivate: true });
    expect(ok.ref_kind).toBe('cloud_ref');
  });
});
