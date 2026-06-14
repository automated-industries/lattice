import { readFileSync, existsSync } from 'node:fs';
import { getS3ConfigRaw } from './user-config.js';
import type { S3StoreConfig } from './s3-store.js';

/**
 * The S3 config for a cloud workspace, resolved per-member. `enabled` gates the
 * whole feature; the rest is the {@link S3StoreConfig} the store consumes. Stored
 * machine-local + encrypted (see user-config `s3-config.enc`), or supplied via env
 * for headless / CI.
 */
export interface S3Config extends S3StoreConfig {
  enabled: boolean;
}

const DEFAULT_PREFIX = 'blobs';

/** Extract the cloud workspace LABEL from a config's `db:` line
 *  (`db: ${LATTICE_DB:label}`), so the S3 config can be keyed by it. Null when the
 *  config isn't a labelled cloud connection. */
export function activeWorkspaceLabel(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, 'utf8');
    const m = /^\s*db:\s*\$\{LATTICE_DB:([A-Za-z0-9._-]+)\}\s*$/m.exec(text);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Build the object to persist for a `POST /api/cloud/s3-config`, MERGING the
 * request body over the previously-stored config. The GET handler redacts
 * `secretAccessKey`, so a UI round-trip never carries it back — without this
 * merge, a partial update (toggling `enabled`, changing `prefix`) would overwrite
 * the stored config and silently drop the secret. A credential/prefix/endpoint is
 * replaced only when the body supplies a non-empty value; otherwise the stored one
 * is preserved. `enabled`/`bucket`/`region` always come from the body (the primary
 * fields a save sets); the route validates them before persisting.
 */
export function mergeS3ConfigForSave(
  prev: Record<string, unknown>,
  body: Record<string, unknown>,
): {
  enabled: boolean;
  bucket: string;
  region: string;
  prefix?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  // body-value-or-stored. `trim` for free-text fields (prefix/endpoint); raw for
  // credentials, which must round-trip byte-exact.
  const pick = (b: unknown, p: unknown, trim: boolean): string | undefined => {
    const bv = trim ? str(b)?.trim() : str(b);
    if (bv) return bv;
    const pv = str(p);
    if (pv) return pv;
    return undefined;
  };
  const prefix = pick(body.prefix, prev.prefix, true);
  const endpoint = pick(body.endpoint, prev.endpoint, true);
  const accessKeyId = pick(body.accessKeyId, prev.accessKeyId, false);
  const secretAccessKey = pick(body.secretAccessKey, prev.secretAccessKey, false);
  return {
    enabled: body.enabled === true,
    bucket: str(body.bucket)?.trim() ?? '',
    region: str(body.region)?.trim() ?? '',
    ...(prefix ? { prefix } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  };
}

/** Coerce a stored raw object into an S3Config, or null if it isn't usable. */
function coerce(raw: Record<string, unknown> | null): S3Config | null {
  if (!raw) return null;
  const enabled = raw.enabled === true;
  const bucket = typeof raw.bucket === 'string' ? raw.bucket : '';
  const region = typeof raw.region === 'string' ? raw.region : '';
  if (!enabled || !bucket || !region) return null;
  const prefix = typeof raw.prefix === 'string' && raw.prefix ? raw.prefix : DEFAULT_PREFIX;
  const endpoint = typeof raw.endpoint === 'string' && raw.endpoint ? raw.endpoint : undefined;
  const accessKeyId = typeof raw.accessKeyId === 'string' ? raw.accessKeyId : '';
  const secretAccessKey = typeof raw.secretAccessKey === 'string' ? raw.secretAccessKey : '';
  // A half-supplied pair is a config error, not a request to use the default chain:
  // dropping it silently would surface only later as an opaque S3 auth failure
  // (internal guideline). Both-absent legitimately falls back to the AWS default chain.
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    console.warn(
      '[s3-config] only one of accessKeyId/secretAccessKey is set; ignoring the partial credential and using the default AWS credential chain. Supply both, or neither.',
    );
  }
  return {
    enabled: true,
    bucket,
    region,
    prefix,
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  };
}

/** S3 config from environment variables (headless / CI). Uses standard `AWS_*`
 *  for credentials so the default credential chain / IAM roles also work when
 *  the explicit keys are absent. */
function fromEnv(): S3Config | null {
  const bucket = process.env.LATTICE_S3_BUCKET;
  const region = process.env.LATTICE_S3_REGION ?? process.env.AWS_REGION;
  if (!bucket || !region) return null;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return {
    enabled: true,
    bucket,
    region,
    prefix: process.env.LATTICE_S3_PREFIX ?? DEFAULT_PREFIX,
    ...(process.env.LATTICE_S3_ENDPOINT ? { endpoint: process.env.LATTICE_S3_ENDPOINT } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  };
}

/**
 * Resolve the active workspace's S3 config: the per-member machine-local config
 * keyed by the workspace label, else the environment. Returns null (S3 off) when
 * neither is configured — so a non-cloud / S3-disabled workspace is untouched.
 */
export function resolveActiveS3Config(configPath: string | undefined): S3Config | null {
  if (configPath) {
    const label = activeWorkspaceLabel(configPath);
    if (label) {
      const stored = coerce(getS3ConfigRaw(label));
      if (stored) return stored;
    }
  }
  return fromEnv();
}
