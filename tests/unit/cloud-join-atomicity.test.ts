/**
 * Joining a cloud must not damage what is already on the machine, and must not
 * throw away something it cannot get back.
 *
 * Joining ends in a small, boring sequence: store a connection under a name,
 * scaffold a workspace whose `db:` line reads that name, open it, adopt it. Every
 * one of those steps has a way of being quietly wrong, and the wrongness is never
 * visible from the outcome — the join reports success and the damage shows up
 * later, on somebody else's workspace or at the next start.
 *
 * Four failures are pinned here, each of which the sequence really had:
 *
 *   1. The connection name is derived from a display name and the store is one
 *      flat map for the whole machine. Two clouds called "Acme" meant the second
 *      join silently repointed the first one's workspace at the second one's
 *      database. Different tenant, different data, no error.
 *   2. Both rollback paths deleted that name outright, so a join that failed
 *      halfway took out whatever connection was already stored under it.
 *   3. The scaffold leaves an existing config file alone. Landing on one left a
 *      registry record marked `cloud` sitting over a config that still opened a
 *      local file — the workspace switcher and the workspace disagreed about
 *      which database it was.
 *   4. The single-use invite was spent BEFORE the workspace was created. A
 *      transient failure while opening the database then left the invite claimed,
 *      the credential deleted, and the member locked out for good: the token
 *      cannot be redeemed twice and the password it carried is written down
 *      nowhere else.
 *
 * Nothing here needs a database. The cloud is a URL, and the injected open
 * handler is what a live session supplies — which is exactly the seam where the
 * fourth failure lived.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudWorkspace } from '../../src/framework/cloud-workspace.js';
import { joinCloud } from '../../src/cloud/join.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { credentialRef, readDbLine, uniqueCredentialKey } from '../../src/framework/db-pointer.js';
import { getDbCredential, saveDbCredential } from '../../src/framework/user-config.js';
import { ensureRootAt, registryPath } from '../../src/framework/lattice-root.js';
import {
  addWorkspace,
  listWorkspaces,
  resolveWorkspacePaths,
} from '../../src/framework/workspace.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CLOUD_A = 'postgres://member_a:pw-a@cloud-a.example.test:5432/acme';
const CLOUD_B = 'postgres://member_b:pw-b@cloud-b.example.test:5432/acme';

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `lattice-join-${prefix}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    saved[k] = process.env[k];
  }
  // The credential store, the registry and the master key all resolve inside the
  // scratch tree — nothing here may reach the machine's own config dir or root.
  const env = scratch('env');
  process.env.LATTICE_CONFIG_DIR = join(env, 'config');
  process.env.LATTICE_ROOT = join(env, 'unused');
  process.env.LATTICE_ENCRYPTION_KEY = KEY;
  mkdirSync(process.env.LATTICE_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh `.lattice` root with nothing in it. */
function emptyRoot(): string {
  return ensureRootAt(scratch('root'));
}

/**
 * Drop every registry record while leaving the directories on disk — which is
 * exactly what removing a workspace does, and the state a rolled-back create
 * leaves behind.
 */
function forgetEveryWorkspace(root: string): void {
  writeFileSync(
    registryPath(root),
    JSON.stringify({ version: 1, activeWorkspaceId: null, workspaces: [] }),
    'utf8',
  );
}

// ── The name a connection is stored under ───────────────────────────────────

describe('the name a connection is stored under', () => {
  it('is left alone when it is free', () => {
    expect(uniqueCredentialKey('acme', CLOUD_A)).toBe('acme');
  });

  it('is reused when it already holds the SAME database', () => {
    // Re-joining a cloud you are already on is not a collision — it is the same
    // connection, and inventing a second name for it would leave two entries
    // that have to be kept in step.
    saveDbCredential('acme', CLOUD_A);
    expect(uniqueCredentialKey('acme', CLOUD_A)).toBe('acme');
  });

  it('is de-collided when it already holds a DIFFERENT database', () => {
    saveDbCredential('acme', CLOUD_A);
    expect(uniqueCredentialKey('acme', CLOUD_B)).toBe('acme-2');
    saveDbCredential('acme-2', CLOUD_B);
    expect(uniqueCredentialKey('acme', 'postgres://c@third.example.test:5432/acme')).toBe('acme-3');
  });
});

describe('joining a second cloud that shares a name', () => {
  it('never repoints the first one', async () => {
    // The failure this exists for: two teams both call their workspace "Acme".
    // Overwriting the stored connection does not fail — it silently points the
    // FIRST workspace at the SECOND team's database.
    const root = emptyRoot();
    await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A);
    await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_B);

    expect(getDbCredential('acme'), "the first team's connection is untouched").toBe(CLOUD_A);
    expect(getDbCredential('acme-2'), 'the second got its own name').toBe(CLOUD_B);

    const [first, second] = listWorkspaces(root);
    expect(readDbLine(resolveWorkspacePaths(root, first!).configPath)).toBe(credentialRef('acme'));
    expect(readDbLine(resolveWorkspacePaths(root, second!).configPath)).toBe(
      credentialRef('acme-2'),
    );
  });

  it('gives the two workspaces separate directories, whatever the filesystem thinks of case', async () => {
    // On the default macOS filesystem and on Windows, `Acme` and `acme` are one
    // directory. A registry-only uniqueness check reports no collision and the
    // second workspace scaffolds straight into the first one's folder.
    const root = emptyRoot();
    await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A);
    await createCloudWorkspace(root, 'acme', 'acme', CLOUD_B);
    const dirsUsed = listWorkspaces(root).map((w) => w.dir.toLowerCase());
    expect(new Set(dirsUsed).size, 'two workspaces, two directories').toBe(2);
  });
});

// ── Rollback ────────────────────────────────────────────────────────────────

describe('a join that fails', () => {
  it('puts back a connection the name already held, rather than deleting it', async () => {
    const root = emptyRoot();
    saveDbCredential('acme', CLOUD_A);

    await expect(
      createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
        open: () => Promise.reject(new Error('network went away')),
      }),
    ).rejects.toThrow(/network went away/);

    expect(getDbCredential('acme'), 'the connection that was already there survives').toBe(CLOUD_A);
    expect(listWorkspaces(root), 'and no half-made workspace is left behind').toHaveLength(0);
  });

  it('removes the connection it added when the name was free', async () => {
    const root = emptyRoot();
    await expect(
      createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
        open: () => Promise.reject(new Error('network went away')),
      }),
    ).rejects.toThrow(/network went away/);
    expect(getDbCredential('acme')).toBeNull();
    expect(listWorkspaces(root)).toHaveLength(0);
  });

  it('refuses to register a cloud workspace whose config opens something else', async () => {
    // A directory left behind by an earlier rolled-back create still holds its
    // config, and the scaffold will not overwrite one. The record would say
    // `cloud` while the config still named a local file — a silent wrong-database
    // open — so the whole thing is refused instead.
    const root = emptyRoot();
    const stale = addWorkspace(root, { displayName: 'Acme', makeActive: false });
    const stalePaths = resolveWorkspacePaths(root, stale);
    writeFileSync(stalePaths.configPath, 'name: "Acme"\ndb: ./Data/database.db\nentities: {}\n');
    // Forget the record but leave the directory — exactly what removing a
    // workspace does today.
    forgetEveryWorkspace(root);

    const id = await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A);
    const created = listWorkspaces(root).find((w) => w.id === id);
    expect(created, 'the join landed').toBeDefined();
    expect(
      readDbLine(resolveWorkspacePaths(root, created!).configPath),
      'and it opens the cloud, not the abandoned local database',
    ).toBe(credentialRef('acme'));
  });
});

// ── The single-use invite ───────────────────────────────────────────────────

describe('spending a single-use invite', () => {
  it('unwinds everything when the invite is refused — nothing was spent', async () => {
    const root = emptyRoot();
    let opened = false;
    await expect(
      createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
        authorize: () => Promise.reject(new Error('this invite has already been used')),
        open: () => {
          opened = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/already been used/);

    expect(opened, 'a refused invite never gets as far as opening anything').toBe(false);
    expect(getDbCredential('acme')).toBeNull();
    expect(listWorkspaces(root)).toHaveLength(0);
  });

  it('KEEPS the workspace and the credential when opening fails after the claim', async () => {
    // The invite is gone and cannot be re-spent, and its password is written down
    // nowhere else. Removing what it bought is what left a member locked out and
    // needing a fresh invite from the owner over a transient network error.
    const root = emptyRoot();
    let claimed = 0;
    await expect(
      createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
        authorize: () => {
          claimed++;
          return Promise.resolve();
        },
        open: () => Promise.reject(new Error('connection timed out')),
      }),
    ).rejects.toThrow(/could not be opened right now[\s\S]*connection timed out/);

    expect(claimed).toBe(1);
    expect(getDbCredential('acme'), 'the credential the invite carried survives').toBe(CLOUD_A);
    const kept = listWorkspaces(root);
    expect(kept, 'and so does the workspace it bought').toHaveLength(1);
    expect(readDbLine(resolveWorkspacePaths(root, kept[0]!).configPath)).toBe(
      credentialRef('acme'),
    );
  });

  it('claims only after the workspace exists, so a claim never outlives a scaffold failure', async () => {
    // Ordering, asserted directly: the claim is the irreversible step, so it must
    // not run until everything before it is already reversible AND done.
    const root = emptyRoot();
    const order: string[] = [];
    await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
      authorize: () => {
        order.push('claim');
        return Promise.resolve();
      },
      open: (paths) => {
        order.push(readDbLine(paths.configPath) === credentialRef('acme') ? 'open' : 'open-wrong');
        return Promise.resolve();
      },
    });
    expect(order).toEqual(['claim', 'open']);
  });

  it('routes the claim through the join capability rather than running it first', async () => {
    // joinCloud must hand the claim to the workspace creator; performing it
    // itself would put the irreversible step back in front of everything.
    const root = emptyRoot();
    let sawAuthorize = false;
    await expect(
      joinCloud(
        {
          host: '127.0.0.1',
          port: 1,
          dbname: 'acme',
          user: 'member_a',
          password: 'pw-a',
        },
        {
          label: 'Acme',
          latticeRoot: root,
          claimInvite: true,
          createCloudWorkspace: (_displayName, _key, _url, auth) => {
            sawAuthorize = typeof auth?.authorize === 'function';
            return Promise.resolve('never-reached');
          },
        },
      ),
      // The probe runs first and this target is not listening, which is the
      // refusal we expect — the creator is never reached.
    ).rejects.toThrow();
    expect(sawAuthorize, 'the creator was never called, so nothing was claimed').toBe(false);
  });

  it('reports a refused invite with the code its callers branch on', async () => {
    const root = emptyRoot();
    let thrown: unknown;
    try {
      await createCloudWorkspace(root, 'Acme', 'acme', CLOUD_A, {
        authorize: () =>
          Promise.reject(Object.assign(new Error('spent'), { code: 'cloud_invite_rejected' })),
      });
    } catch (e) {
      thrown = e;
    }
    expect(cloudErrorCode(thrown)).toBe('cloud_invite_rejected');
  });
});

// ── The registry and the disk agree ─────────────────────────────────────────

describe('the workspace directory a join scaffolds into', () => {
  it('is never one the registry has forgotten but the disk still has', () => {
    const root = emptyRoot();
    const first = addWorkspace(root, { displayName: 'Notes', makeActive: false });
    const firstDir = first.dir;
    // Forget it the way removing a workspace does: the record goes, the files stay.
    forgetEveryWorkspace(root);
    expect(existsSync(resolveWorkspacePaths(root, first).configPath)).toBe(true);

    const second = addWorkspace(root, { displayName: 'Notes', makeActive: false });
    expect(second.dir, 'the new workspace gets its own directory').not.toBe(firstDir);
    expect(readFileSync(resolveWorkspacePaths(root, second).configPath, 'utf8')).toContain(
      'name: "Notes"',
    );
  });
});
