/**
 * Where a shared workspace keeps its file bytes, without a server.
 *
 * The write is owner-only and shared-database-only, and both refusals used to be
 * response codes written inside a request handler — which meant a caller outside
 * a browser could not perform the operation at all, and, had the setter simply
 * been exported instead, would have performed it with neither gate attached.
 *
 * So what is pinned here is that the gates travel WITH the capability and are
 * TAGGED, because an adapter has to be able to tell a refusal it should answer
 * 400 or 403 for from a fault it should answer 500 for — and a command-line
 * caller has to be able to tell "you are not allowed" from "it broke".
 *
 * The read is pinned for the opposite reason: it must never hand back the secret
 * it is holding, only the fact that one is held.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { readCloudFileStorage, configureCloudFileStorage } from '../../src/ops/cloud-storage.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';

const dirs: string[] = [];
const prev: Record<string, string | undefined> = {};
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lattice-cloud-storage-'));
  for (const key of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    prev[key] = process.env[key];
  }
  // The settings store is machine-local and encrypted; keep both inside the
  // scratch dir rather than the machine's own config dir.
  process.env.LATTICE_CONFIG_DIR = join(scratch, 'config');
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
  process.env.LATTICE_ROOT = join(scratch, 'unused-root');
  process.env.LATTICE_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
});

afterAll(() => {
  for (const [key, value] of Object.entries(prev)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A local workspace — which is exactly what this capability must refuse. */
function localWorkspace(): { configPath: string; db: Lattice } {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-storage-ws-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const configPath = join(dir, 'lattice.config.yml');
  writeFileSync(configPath, ['db: ./data/test.db', ''].join('\n'), 'utf8');
  return { configPath, db: new Lattice(join(dir, 'data', 'test.db')) };
}

describe('configureCloudFileStorage', () => {
  it('refuses a database that is not shared, with a reason an adapter can map', async () => {
    // The gate that has to live WITH the operation: a local workspace already
    // stores its bytes beside its database, and pointing it at an object store
    // would mean nothing while still writing credentials to disk.
    const { configPath, db } = localWorkspace();
    await db.init();
    try {
      let caught: unknown;
      try {
        await configureCloudFileStorage(db, {
          configPath,
          settings: { enabled: true, bucket: 'b', region: 'r' },
        });
      } catch (e) {
        caught = e;
      }
      expect(cloudErrorCode(caught)).toBe('cloud_required');
      // Refused BEFORE anything was written — the settings store is untouched.
      expect(readCloudFileStorage(configPath).enabled).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('readCloudFileStorage', () => {
  it('reads a workspace with no stored settings as everything off', async () => {
    // Asking is legitimate anywhere, so a workspace that is not a labelled shared
    // connection answers rather than raising.
    const { configPath, db } = localWorkspace();
    await db.init();
    try {
      expect(readCloudFileStorage(configPath)).toEqual({
        enabled: false,
        bucket: null,
        region: null,
        prefix: null,
        endpoint: null,
        accessKeyId: null,
        hasSecret: false,
      });
    } finally {
      db.close();
    }
  });

  it('reports only THAT a secret is held, never the secret', () => {
    // The read crosses process and network boundaries the write does not, so the
    // shape itself has to make returning the key impossible rather than relying
    // on each caller to remember to strip it.
    const shape = readCloudFileStorage(join(scratch, 'no-such-config.yml'));
    expect(Object.keys(shape)).not.toContain('secretAccessKey');
    expect(shape.hasSecret).toBe(false);
  });
});
