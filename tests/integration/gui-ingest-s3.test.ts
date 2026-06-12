/**
 * Uploading with S3 enabled: the bytes are pushed to S3 (so other members can
 * pull them) AND the uploader keeps a local blob (hybrid). The row records a
 * cloud_ref/s3 reference; the object lands under `<prefix>/<sha256>`. Mocked
 * `@aws-sdk/client-s3` backs an in-memory bucket; no AI (ANTHROPIC unset).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuiServer, type GuiServerHandle } from '../../src/gui/server.js';

const { bucketState, ctl } = vi.hoisted(() => ({
  bucketState: new Map<string, Buffer>(),
  ctl: { failPut: false },
}));

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
        if (ctl.failPut) {
          return Promise.reject(
            Object.assign(new Error('AccessDenied: simulated PUT failure'), {
              name: 'AccessDenied',
            }),
          );
        }
        bucketState.set(cmd.input.Key, cmd.input.Body);
        return Promise.resolve({});
      }
      if (cmd instanceof HeadObjectCommand) {
        return bucketState.has(cmd.input.Key)
          ? Promise.resolve({})
          : Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
      }
      return Promise.reject(new Error('unsupported in upload test'));
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
  'ANTHROPIC_API_KEY',
  'LATTICE_S3_BUCKET',
  'LATTICE_S3_REGION',
  'LATTICE_S3_PREFIX',
];

beforeEach(() => {
  bucketState.clear();
  ctl.failPut = false;
  const cfgDir = mkdtempSync(join(tmpdir(), 'lattice-s3i-cfg-'));
  dirs.push(cfgDir);
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.LATTICE_CONFIG_DIR = cfgDir;
  process.env.LATTICE_ENCRYPTION_KEY = 's3i-test-key';
  delete process.env.ANTHROPIC_API_KEY; // no AI — deterministic ingest
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-s3i-'));
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

async function getFile(url: string, id: string): Promise<Record<string, unknown>> {
  return (await fetch(`${url}/api/tables/files/rows/${id}`).then((r) => r.json())) as Record<
    string,
    unknown
  >;
}

// 1×1 transparent PNG — retained locally (previewable) AND pushed to S3.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('S3-backed upload', () => {
  it('pushes bytes to S3 and records a cloud_ref, keeping the local blob (hybrid)', async () => {
    const s = await boot();
    const res = await fetch(`${s.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'pic.png' },
      body: PNG,
    });
    expect(res.status).toBe(201);
    const uploaded = (await res.json()) as { id: string; s3?: { status: string; key?: string } };
    const { id } = uploaded;
    // Success surfaces the S3 outcome so the GUI can distinguish a clean cloud share.
    expect(uploaded.s3?.status).toBe('stored');

    const row = await getFile(s.url, id);
    expect(row.ref_kind).toBe('cloud_ref');
    expect(row.ref_provider).toBe('s3');
    expect(typeof row.sha256).toBe('string');
    expect(String(row.ref_uri)).toMatch(/^s3:\/\/test-bucket\/blobs\//);
    // Hybrid: the uploader's local copy is kept too.
    expect(typeof row.blob_path).toBe('string');
    // The object landed in S3 under <prefix>/<sha256>.
    expect(bucketState.has(`blobs/${String(row.sha256)}`)).toBe(true);
    const src = JSON.parse(String(row.source_json)) as { bucket: string; key: string };
    expect(src.bucket).toBe('test-bucket');
    expect(src.key).toBe(`blobs/${String(row.sha256)}`);

    // The uploader serves it from the fast local path.
    const blob = await fetch(`${s.url}/api/files/${id}/blob`);
    expect(blob.status).toBe(200);
    expect(Buffer.from(await blob.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('surfaces the failure (does not 500, does not pretend success) when the S3 PUT fails on an enabled cloud', async () => {
    // S3 is enabled (env), but the PUT fails (rotated cred / outage / region
    // mismatch). The upload must not 500, but it also must NOT return a byte-
    // identical success: other members fetch from S3, so a silently-dropped PUT
    // would 404 for everyone but the uploader. The response says so (Rule 16).
    ctl.failPut = true;
    const s = await boot();
    const res = await fetch(`${s.url}/api/ingest/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'pic.png' },
      body: PNG,
    });
    expect(res.status).toBe(201); // never 500 — the upload itself succeeded locally
    const body = (await res.json()) as { id: string; s3?: { status: string; error?: string } };
    // The degradation is reported, not swallowed.
    expect(body.s3).toBeDefined();
    expect(body.s3?.status).toBe('failed');
    expect(typeof body.s3?.error).toBe('string');

    // Nothing reached the bucket.
    expect(bucketState.size).toBe(0);

    // The row is local-only (the uploader keeps their copy) — NOT a cloud_ref that
    // would imply the bytes are shared.
    const row = await getFile(s.url, body.id);
    expect(row.ref_kind).toBe('blob');
    expect(row.ref_provider).toBeFalsy();

    // The uploader still serves from local; other members (no local copy, no S3
    // object) would correctly get nothing — but the uploader was TOLD at upload time.
    const blob = await fetch(`${s.url}/api/files/${body.id}/blob`);
    expect(blob.status).toBe(200);
  });
});
