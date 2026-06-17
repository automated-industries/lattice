/**
 * Concurrency regression for the machine-local credential store.
 *
 * Opening a workspace whose `db:` line is a raw `postgres://…` URL heals it into
 * the encrypted credential store (`healRawDbUrl` → `saveDbCredential`). That made
 * workspace-open a load-modify-write of two shared, process-global files (the
 * master key + the credentials blob). Two concurrent opens — two `lattice gui`
 * launches, or the parallel test workers all booting GUIs against the same DB —
 * raced two ways:
 *   1. lost updates — a whole-file save clobbered a concurrently-written entry,
 *      so a config left referencing `${LATTICE_DB:label}` could find no saved
 *      credential ("no credential is saved for that label").
 *   2. master-key race — two fresh processes wrote divergent `master.key`s, so
 *      each other's ciphertext became undecryptable.
 *
 * This drives REAL OS concurrency (N child processes, no in-process simulation):
 * each child saves a distinct credential into one shared config dir, with NO
 * pinned `LATTICE_ENCRYPTION_KEY` so the master-key creation path races too. Every
 * write must survive. The fix is a cross-process lock + atomic (temp+rename)
 * writes around the master-key creation and the credential load-modify-write.
 *
 * The module under test is bundled with esbuild (CJS) so the children are plain
 * Node scripts — portable to CI's Node 20 (no TS loader, and `dist/` isn't built
 * at test time).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

let scratch: string;
let saveChild: string;
let listChild: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'cred-conc-'));
  const bundlePath = join(scratch, 'user-config.bundle.cjs');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: ['src/framework/user-config.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const req = JSON.stringify(bundlePath);
  saveChild = join(scratch, 'child-save.cjs');
  writeFileSync(
    saveChild,
    `const { saveDbCredential } = require(${req});\n` +
      `const [label, url] = process.argv.slice(2);\n` +
      `saveDbCredential(label, url);\n`,
    'utf8',
  );
  listChild = join(scratch, 'child-list.cjs');
  writeFileSync(
    listChild,
    `const { listDbCredentials } = require(${req});\n` +
      `process.stdout.write(JSON.stringify(listDbCredentials()));\n`,
    'utf8',
  );
}, 60_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Spawn `script` against `configDir` with NO pinned key; resolve with stdout. */
function run(configDir: string, script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LATTICE_CONFIG_DIR: configDir };
    delete env.LATTICE_ENCRYPTION_KEY; // exercise the master-key creation path
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err}`));
    });
  });
}

describe('credential store — concurrent writers never lose updates', () => {
  it('persists every label written by N concurrent processes (RMW + master-key race)', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cred-store-'));
    const N = 16;
    const labels = Array.from({ length: N }, (_, i) => `lbl_${i}`);

    try {
      // Launch all writers as simultaneously as possible to force contention.
      await Promise.all(
        labels.map((l, i) => run(configDir, saveChild, [l, `postgres://h/db${i}`])),
      );

      const saved = JSON.parse(await run(configDir, listChild)) as string[];
      expect(saved.slice().sort()).toEqual(labels.slice().sort());
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 60_000);
});
