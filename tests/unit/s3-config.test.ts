/**
 * S3 config resolution: the env-var fallback (headless/CI) and the workspace
 * label parse. The machine-local encrypted store is exercised end-to-end by the
 * GUI tests; here we cover the pure resolution + label extraction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveActiveS3Config,
  activeWorkspaceLabel,
  mergeS3ConfigForSave,
} from '../../src/framework/s3-config.js';

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

describe('mergeS3ConfigForSave — partial updates must not drop the stored secret', () => {
  const stored = {
    enabled: true,
    bucket: 'b',
    region: 'us-east-1',
    prefix: 'team/blobs',
    accessKeyId: 'AKIA-OLD',
    secretAccessKey: 'super-secret',
  };

  it('preserves the stored secret + access key when the body omits them', () => {
    // The GET handler redacts secretAccessKey, so a UI round-trip that just flips a
    // field never carries the secret back. The merge must keep it.
    const out = mergeS3ConfigForSave(stored, { enabled: true, bucket: 'b', region: 'us-east-1' });
    expect(out.secretAccessKey).toBe('super-secret');
    expect(out.accessKeyId).toBe('AKIA-OLD');
    expect(out.prefix).toBe('team/blobs');
  });

  it('preserves the secret while changing a non-credential field (prefix)', () => {
    const out = mergeS3ConfigForSave(stored, {
      enabled: true,
      bucket: 'b',
      region: 'us-east-1',
      prefix: 'new/prefix',
    });
    expect(out.prefix).toBe('new/prefix');
    expect(out.secretAccessKey).toBe('super-secret');
  });

  it('replaces the credential when the body supplies a new non-empty value', () => {
    const out = mergeS3ConfigForSave(stored, {
      enabled: true,
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA-NEW',
      secretAccessKey: 'rotated',
    });
    expect(out.accessKeyId).toBe('AKIA-NEW');
    expect(out.secretAccessKey).toBe('rotated');
  });

  it('omits credentials entirely when neither body nor stored has them', () => {
    const out = mergeS3ConfigForSave(
      { enabled: false, bucket: 'b', region: 'us-east-1' },
      { enabled: true, bucket: 'b', region: 'us-east-1' },
    );
    expect(out.accessKeyId).toBeUndefined();
    expect(out.secretAccessKey).toBeUndefined();
  });

  it('takes enabled/bucket/region from the body and trims them', () => {
    const out = mergeS3ConfigForSave(stored, {
      enabled: false,
      bucket: '  b2  ',
      region: '  eu-west-1 ',
    });
    expect(out).toMatchObject({ enabled: false, bucket: 'b2', region: 'eu-west-1' });
    // credentials still preserved across a disable toggle
    expect(out.secretAccessKey).toBe('super-secret');
  });
});
