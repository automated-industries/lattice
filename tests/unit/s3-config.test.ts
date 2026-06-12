/**
 * S3 config resolution: the env-var fallback (headless/CI) and the workspace
 * label parse. The machine-local encrypted store is exercised end-to-end by the
 * GUI tests; here we cover the pure resolution + label extraction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActiveS3Config, activeWorkspaceLabel } from '../../src/framework/s3-config.js';

const ENV_KEYS = [
  'LATTICE_S3_BUCKET',
  'LATTICE_S3_REGION',
  'LATTICE_S3_PREFIX',
  'LATTICE_S3_ENDPOINT',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function configWith(dbLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-s3cfg-'));
  dirs.push(dir);
  const p = join(dir, 'lattice.config.yml');
  writeFileSync(p, `${dbLine}\nentities: {}\n`, 'utf8');
  return p;
}

describe('activeWorkspaceLabel', () => {
  it('extracts the label from a ${LATTICE_DB:label} db line', () => {
    expect(activeWorkspaceLabel(configWith('db: ${LATTICE_DB:acme.cloud}'))).toBe('acme.cloud');
  });
  it('is null for a raw url / sqlite db line', () => {
    expect(activeWorkspaceLabel(configWith('db: ./data/local.db'))).toBeNull();
    expect(activeWorkspaceLabel(configWith('db: postgres://u:p@h/db'))).toBeNull();
  });
});

describe('resolveActiveS3Config — env fallback', () => {
  it('returns the env-configured bucket/region/prefix + credentials', () => {
    clearEnv();
    process.env.LATTICE_S3_BUCKET = 'my-bucket';
    process.env.LATTICE_S3_REGION = 'us-west-2';
    process.env.LATTICE_S3_PREFIX = 'team/blobs';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const cfg = resolveActiveS3Config(undefined);
    expect(cfg).toMatchObject({
      enabled: true,
      bucket: 'my-bucket',
      region: 'us-west-2',
      prefix: 'team/blobs',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
    });
  });

  it('defaults the prefix and omits credentials when not set (default chain)', () => {
    clearEnv();
    process.env.LATTICE_S3_BUCKET = 'b';
    process.env.AWS_REGION = 'eu-west-1';
    const cfg = resolveActiveS3Config(undefined);
    expect(cfg).toMatchObject({ enabled: true, bucket: 'b', region: 'eu-west-1', prefix: 'blobs' });
    expect(cfg?.credentials).toBeUndefined();
  });

  it('is null when nothing is configured (S3 off — non-cloud untouched)', () => {
    clearEnv();
    expect(resolveActiveS3Config(undefined)).toBeNull();
    expect(resolveActiveS3Config(configWith('db: ./data/local.db'))).toBeNull();
  });
});
