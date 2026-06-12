/**
 * Serving an S3-backed file: a `cloud_ref` row with no local copy streams its
 * bytes from S3 through `GET /api/files/:id/blob`. The mocked `@aws-sdk/client-s3`
 * (lazy-imported, so it intercepts the server's import too) backs an in-memory
 * bucket. The RLS gate is the route's `db.get('files', id)` (unchanged) — an
 * unknown/invisible id 404s before S3 is ever touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const { bucketState } = vi.hoisted(() => ({ bucketState: new Map<string, Buffer>() }));

vi.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    constructor(public input: { Key: string; Body: Buffer }) {}
  }
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class HeadObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class S3Client {
    send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof PutObjectCommand) {
        bucketState.set(cmd.input.Key, cmd.input.Body);
        return Promise.resolve({});
      }
      if (cmd instanceof HeadObjectCommand) {
        return bucketState.has(cmd.input.Key)
          ? Promise.resolve({})
          : Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
      }
      if (cmd instanceof GetObjectCommand) {
        const buf = bucketState.get(cmd.input.Key);
        return buf
          ? Promise.resolve({ Body: Readable.from(buf) })
          : Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
      }
      return Promise.reject(new Error('unknown command'));
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand };
});

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV = [
  'LATTICE_CONFIG_DIR',
  'LATTICE_ENCRYPTION_KEY',
  'LATTICE_S3_BUCKET',
  'LATTICE_S3_REGION',
  'LATTICE_S3_PREFIX',
];

beforeEach(() => {
  bucketState.clear();
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-s3-cfg-'));
  dirs.push(cfgDir);
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 's3-test-key';
  process.env.LATTICE_S3_BUCKET = 'test-bucket';
  process.env.LATTICE_S3_REGION = 'us-east-1';
  process.env.LATTICE_S3_PREFIX = 'blobs';
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function boot(): Promise<GuiServerHandle> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-s3-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(
    configPath,
    [
      'db: ./data/test.db',
      '',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: uuid, primaryKey: true }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
  );
  const server = await startGuiServer({
    configPath,
    outputDir: join(root, 'context'),
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
  });
  servers.push(server);
  return server;
}

/** Seed a cloud_ref (s3) files row pointing at an object already in the bucket. */
async function seedS3FileRow(url: string, content: string): Promise<string> {
  const sha = createHash('sha256').update(content).digest('hex');
  const key = `blobs/${sha}`;
  bucketState.set(key, Buffer.from(content));
  const row = {
    id: randomUUID(),
    original_name: 'remote.txt',
    mime: 'text/plain',
    sha256: sha,
    ref_kind: 'cloud_ref',
    ref_provider: 's3',
    ref_uri: `s3://test-bucket/${key}`,
    source_json: JSON.stringify({ bucket: 'test-bucket', key, region: 'us-east-1' }),
  };
  const res = await fetch(`${url}/api/tables/files/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(row),
  });
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

describe('S3-backed file serving', () => {
  it('streams a cloud_ref file from S3 when there is no local copy', async () => {
    const s = await boot();
    const id = await seedS3FileRow(s.url, 'bytes that live only in S3');
    const r = await fetch(`${s.url}/api/files/${id}/blob`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain');
    expect(await r.text()).toBe('bytes that live only in S3');
    // The bytes + mime come from a row another member can write (PutObject + row
    // CRUD), so the serve response must neutralize active content served same-origin.
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves a member-staged text/html cloud_ref with nosniff + a sandbox CSP (no same-origin script execution)', async () => {
    // A malicious member stages HTML/JS in the shared bucket and points a row's
    // mime at text/html. Serving it inline must not let it run against another
    // member's GUI origin.
    const s = await boot();
    const payload = '<script>steal()</script>';
    const sha = createHash('sha256').update(payload).digest('hex');
    const key = `blobs/${sha}`;
    bucketState.set(key, Buffer.from(payload));
    const row = {
      id: randomUUID(),
      original_name: 'evil.html',
      mime: 'text/html',
      sha256: sha,
      ref_kind: 'cloud_ref',
      ref_provider: 's3',
      ref_uri: `s3://test-bucket/${key}`,
      source_json: JSON.stringify({ bucket: 'test-bucket', key, region: 'us-east-1' }),
    };
    const seeded = await fetch(`${s.url}/api/tables/files/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    });
    const { id } = (await seeded.json()) as { id: string };
    const r = await fetch(`${s.url}/api/files/${id}/blob`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // A no-allowances sandbox CSP — script/forms/same-origin all denied.
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('still 404s an unknown id (the RLS-gated db.get returns null before S3)', async () => {
    const s = await boot();
    const r = await fetch(`${s.url}/api/files/${randomUUID()}/blob`);
    expect(r.status).toBe(404);
  });

  it('502s when the S3 object is missing (bytes genuinely gone)', async () => {
    const s = await boot();
    const id = await seedS3FileRow(s.url, 'will be removed');
    // Drop the object from the bucket → the GET fails.
    bucketState.clear();
    const r = await fetch(`${s.url}/api/files/${id}/blob`);
    expect(r.status).toBe(502);
  });
});
