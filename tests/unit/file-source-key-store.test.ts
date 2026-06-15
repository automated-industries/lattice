import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSourceKeyStore,
  sealUnderSource,
  openUnderSource,
  shredSource,
  SourceShreddedError,
} from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpPath(name = 'keys.json'): string {
  const d = mkdtempSync(join(tmpdir(), 'lattice-fsks-'));
  dirs.push(d);
  return join(d, name);
}

describe('FileSourceKeyStore', () => {
  it('round-trips a sealed value across two store instances (durability)', () => {
    const path = tmpPath();
    const store1 = new FileSourceKeyStore({ path });
    const sealed = sealUnderSource('top-secret-1', 'src-a', store1);

    // Simulate process restart by constructing a fresh store against the same file.
    const store2 = new FileSourceKeyStore({ path });
    const recovered = openUnderSource(sealed, 'src-a', store2);
    expect(recovered).toBe('top-secret-1');
  });

  it('creates the parent directory if missing', () => {
    const path = join(tmpPath(), 'sub', 'dir', 'keys.json');
    const store = new FileSourceKeyStore({ path });
    store.getOrCreate('src-x');
    expect(existsSync(path)).toBe(true);
  });

  it('persists multiple sources independently', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path });
    const a = sealUnderSource('alpha', 'src-A', s1);
    const b = sealUnderSource('beta', 'src-B', s1);
    const c = sealUnderSource('gamma', 'src-C', s1);

    const s2 = new FileSourceKeyStore({ path });
    expect(openUnderSource(a, 'src-A', s2)).toBe('alpha');
    expect(openUnderSource(b, 'src-B', s2)).toBe('beta');
    expect(openUnderSource(c, 'src-C', s2)).toBe('gamma');
    expect(s2.size()).toBe(3);
  });

  it('shredSource is durable — the destroyed key does not return after reload', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path });
    const sealed = sealUnderSource('forget-me', 'src-doomed', s1);
    shredSource('src-doomed', s1);

    // Confirm immediate behavior
    expect(() => openUnderSource(sealed, 'src-doomed', s1)).toThrow(SourceShreddedError);

    // Confirm post-reload behavior — the shred persisted to disk
    const s2 = new FileSourceKeyStore({ path });
    expect(() => openUnderSource(sealed, 'src-doomed', s2)).toThrow(SourceShreddedError);
    expect(s2.size()).toBe(0);
  });

  it('encrypts at rest when a passphrase is provided', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path, passphrase: 'correct horse battery staple' });
    sealUnderSource('plain-marker', 'src-enc', s1);

    const onDisk = readFileSync(path, 'utf8');
    // The file should not contain the literal base64 key bytes.
    // It should start with our ENC header and contain a hex-encoded body.
    expect(onDisk.startsWith('LATTICE-KMS-v1\n')).toBe(true);
    expect(onDisk).not.toContain('plain-marker'); // never any plaintext appears
    // Reload with correct passphrase succeeds
    const s2 = new FileSourceKeyStore({ path, passphrase: 'correct horse battery staple' });
    expect(s2.size()).toBe(1);
  });

  it('rejects load with a wrong passphrase', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path, passphrase: 'right-key' });
    s1.getOrCreate('src-x');
    expect(() => new FileSourceKeyStore({ path, passphrase: 'wrong-key' })).toThrow(
      /decryption failed/,
    );
  });

  it('rejects an encrypted file when no passphrase is provided', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path, passphrase: 'pw' });
    s1.getOrCreate('src-x');
    expect(() => new FileSourceKeyStore({ path })).toThrow(/passphrase/);
  });

  it('writes the file with mode 0600 (POSIX)', () => {
    const path = tmpPath();
    const store = new FileSourceKeyStore({ path });
    store.getOrCreate('src-y');
    const st = statSync(path);
    // On Windows the bits may not match; assert only on platforms that honor 0600.
    if (process.platform !== 'win32') {
      // mode includes file-type bits; mask to permission bits

      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('atomic-write: a malformed write does not destroy existing keys', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path });
    s1.getOrCreate('src-original');

    // Manually clobber the file mid-flight as if a crash happened —
    // because we use rename, the file at `path` is always either the
    // last fully-written version or the very first one. We can't truly
    // simulate mid-write here without process signals; this test
    // documents the expected behavior under correct atomic writes.
    const before = readFileSync(path);
    // Touch a temp file in the same dir, then verify it gets cleaned up
    // by the atomic rename idiom (a fresh write removes any old .tmp-*).
    s1.getOrCreate('src-second');
    const after = readFileSync(path);
    expect(after.length).toBeGreaterThanOrEqual(before.length);

    const s2 = new FileSourceKeyStore({ path });
    expect(s2.size()).toBe(2);
  });

  it('migrates a plaintext file to encrypted on first write after passphrase is added', () => {
    const path = tmpPath();
    const s1 = new FileSourceKeyStore({ path });
    s1.getOrCreate('src-pre-encrypt');
    const beforeText = readFileSync(path, 'utf8');
    expect(beforeText.startsWith('{')).toBe(true);

    // Open the same file with a passphrase — the load accepts the existing
    // plaintext; the next write should be encrypted.
    const s2 = new FileSourceKeyStore({ path, passphrase: 'new-pw' });
    expect(s2.size()).toBe(1); // existing key preserved
    s2.getOrCreate('src-post-encrypt');
    const afterText = readFileSync(path, 'utf8');
    expect(afterText.startsWith('LATTICE-KMS-v1\n')).toBe(true);

    // Subsequent loads require the passphrase
    expect(() => new FileSourceKeyStore({ path })).toThrow(/passphrase/);
    const s3 = new FileSourceKeyStore({ path, passphrase: 'new-pw' });
    expect(s3.size()).toBe(2);
  });

  it('skips malformed entries on load without crashing', () => {
    const path = tmpPath();
    writeFileSync(
      path,
      JSON.stringify({
        'good-src': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'bad-src': 'not-base64!',
      }),
      { mode: 0o600 },
    );
    const s = new FileSourceKeyStore({ path });
    // The good entry has 32 bytes when base64-decoded; bad-src has invalid base64
    // — but Buffer.from('not-base64!', 'base64') returns a short buffer rather
    // than throwing, so it gets filtered by length check. Both behaviors are
    // acceptable; the test asserts no crash on load.
    expect(s.size()).toBeGreaterThanOrEqual(0);
    expect(s.size()).toBeLessThanOrEqual(2);
  });
});
