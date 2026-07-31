/**
 * Where a shared workspace keeps its file bytes, headless.
 *
 * A local workspace stores an uploaded document beside its database. A shared one
 * cannot: the database is remote and everybody on it has to be able to fetch the
 * same bytes, so the owner points the workspace at an object store instead. That
 * setting is the difference between "everyone can open this contract" and "only
 * the machine it was uploaded from can", and it could only be made by clicking.
 *
 * Two things about the write are easy to get wrong on your own, which is why this
 * is one call rather than a setter:
 *
 *   THE MERGE. The read side redacts the secret — it has to, it crosses the wire
 *   — so anything that round-trips the settings and writes them back would erase
 *   the credential while looking like it changed a prefix. A partial update is
 *   merged over what is stored, and a credential is replaced only by a new one.
 *
 *   THE IN-DATABASE PRESIGNER. Members who hold no object-store credentials of
 *   their own still need to fetch bytes for the files they can see, so enabling
 *   storage also installs the presigner inside the shared database. One owner
 *   action turns it on for everybody; forgetting it leaves every other member
 *   unable to open a single file, with nothing to indicate why.
 *
 * The settings are MACHINE-LOCAL and encrypted at rest, never written into the
 * shared database — the credential is the operator's, not the workspace's.
 *
 * There is deliberately no command verb. The secret would have to arrive on an
 * argument list, where a shell history and the process table both keep a copy;
 * a library caller passes it as a value and it stays in memory.
 */
import type { Lattice } from '../lattice.js';
import { getS3ConfigRaw, saveS3ConfigRaw } from '../framework/user-config.js';
import { activeWorkspaceLabel, mergeS3ConfigForSave } from '../framework/s3-config.js';
import { cloudRlsInstalled, canManageRoles } from '../framework/cloud-connect.js';
import { cloudError } from '../cloud/errors.js';

/**
 * The stored file-storage settings for one shared workspace, as they can safely
 * be shown. The secret is reported only as PRESENT — reading it back out is not
 * something any caller needs, and every place it could be returned to is a place
 * it could leak.
 */
export interface CloudFileStorage {
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  prefix: string | null;
  endpoint: string | null;
  accessKeyId: string | null;
  /** Whether a secret key is stored. Never the key itself. */
  hasSecret: boolean;
}

/**
 * Read this machine's file-storage settings for the workspace at `configPath`.
 *
 * Machine-local: no database, no network. A workspace that is not a labelled
 * shared connection has no settings, which reads as everything off rather than
 * as an error — asking is legitimate wherever you are.
 */
export function readCloudFileStorage(configPath: string): CloudFileStorage {
  const label = activeWorkspaceLabel(configPath);
  const raw = label ? getS3ConfigRaw(label) : null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    enabled: raw?.enabled === true,
    bucket: str(raw?.bucket),
    region: str(raw?.region),
    prefix: str(raw?.prefix),
    endpoint: str(raw?.endpoint),
    accessKeyId: str(raw?.accessKeyId),
    hasSecret: typeof raw?.secretAccessKey === 'string' && raw.secretAccessKey.length > 0,
  };
}

/** A change to the file-storage settings. Anything omitted keeps its stored value. */
export interface CloudFileStorageInput {
  /** The shared workspace's configuration file — its label keys the settings. */
  configPath: string;
  /**
   * The fields to write, merged over what is stored. `enabled`, `bucket`, and
   * `region` are taken from here as given; a blank credential, prefix, or
   * endpoint keeps the stored one rather than clearing it.
   */
  settings: Record<string, unknown>;
}

/** What configuring file storage left in force. */
export interface CloudFileStorageResult {
  enabled: boolean;
  bucket: string | null;
  /**
   * Whether the in-database presigner was installed, so keyless members can
   * fetch bytes. False when storage is off, when no credential was supplied, or
   * when the database refused — see {@link CloudFileStorageResult.presignerError}.
   */
  presignerInstalled: boolean;
  /**
   * Why the presigner did not install, when it was attempted and failed. The
   * settings are still saved: the owner's own uploads work either way, and a
   * refusal here is a fixable privilege problem, not a reason to lose the save.
   * Null when nothing was attempted or the attempt succeeded.
   */
  presignerError: string | null;
}

/**
 * Point a shared workspace at an object store for its file bytes, and open the
 * in-database presigner so every member can read them.
 *
 * Owner-only, and only on a shared database — both refusals come back tagged, so
 * a request adapter maps them to a status and a command-line caller sees the
 * sentence.
 *
 * @throws a tagged `cloud_required` off a shared database, `cloud_owner_only` for
 *         a member, and `invalid_request` for a workspace with no label or a
 *         request to enable storage without a bucket and region.
 */
export async function configureCloudFileStorage(
  db: Lattice,
  input: CloudFileStorageInput,
): Promise<CloudFileStorageResult> {
  if (db.getDialect() !== 'postgres' || !(await cloudRlsInstalled(db))) {
    throw cloudError('cloud_required', 'The active database is not a Lattice cloud');
  }
  if (!(await canManageRoles(db))) {
    throw cloudError('cloud_owner_only', 'Only a cloud owner can configure S3 file storage');
  }
  const label = activeWorkspaceLabel(input.configPath);
  if (!label) {
    throw cloudError('invalid_request', 'The active workspace is not a labelled cloud connection');
  }
  const toSave = mergeS3ConfigForSave(getS3ConfigRaw(label) ?? {}, input.settings);
  if (toSave.enabled && (!toSave.bucket || !toSave.region)) {
    throw cloudError('invalid_request', 'bucket and region are required to enable S3');
  }
  saveS3ConfigRaw(label, toSave);

  // The presigner is what makes the stored bytes reachable by members who hold no
  // credentials of their own. It is attempted only when there is something to
  // presign WITH, and a refusal is reported rather than thrown: the settings are
  // already saved, and losing that save would leave the owner worse off than the
  // partial success they actually have.
  const ak = typeof toSave.accessKeyId === 'string' ? toSave.accessKeyId : '';
  const sk = typeof toSave.secretAccessKey === 'string' ? toSave.secretAccessKey : '';
  let presignerInstalled = false;
  let presignerError: string | null = null;
  if (
    toSave.enabled &&
    typeof toSave.bucket === 'string' &&
    typeof toSave.region === 'string' &&
    ak &&
    sk
  ) {
    try {
      await db.enableCloudFilePresigning({
        bucket: toSave.bucket,
        region: toSave.region,
        accessKey: ak,
        secretKey: sk,
        ...(typeof toSave.prefix === 'string' ? { prefix: toSave.prefix } : {}),
        ...(typeof toSave.endpoint === 'string' ? { endpoint: toSave.endpoint } : {}),
      });
      presignerInstalled = true;
    } catch (e) {
      presignerError = (e as Error).message;
      console.warn(
        '[cloud file storage] could not enable the in-database presigner:',
        presignerError,
      );
    }
  }
  return {
    enabled: toSave.enabled,
    bucket: toSave.bucket || null,
    presignerInstalled,
    presignerError,
  };
}
