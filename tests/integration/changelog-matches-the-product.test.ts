/**
 * The release note is the only account of a release most people ever read, and a
 * sentence in its Security section is read as a control that exists. One did not.
 * The note said that moving a workspace onto a shared database is refused up
 * front where a deployment's manager owns workspaces — the way securing one is.
 * It is not, deliberately: the database a migration secures is the one the person
 * just supplied, not the one the manager provisioned, so the operation states its
 * own answer instead of reading it off the session.
 *
 * Checked in two steps, in this order: drive the real capabilities to find out
 * what they do, then hold the note to that. Asserting on the prose alone would
 * pin today's wording and re-rot the moment the code moved — the point is to fail
 * when the note and the product disagree, whichever of them moved. So a later
 * change that really does refuse a migration in a managed session fails the first
 * half here rather than the second, and the note is re-agreed with it.
 *
 * No Postgres: an up-front refusal is up-front. Aimed at a port nothing listens
 * on, a migration that refused for the session would never get as far as the
 * target, so which of the two reasons comes back IS the measurement.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lattice } from '../../src/lattice.js';
import { registerNativeEntities } from '../../src/framework/native-entities.js';
import { secureCloud } from '../../src/cloud/setup.js';
import { migrateWorkspaceToCloud } from '../../src/cloud/migrate.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CHANGELOG = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

/** Nothing listens here, so a probe of it fails without reaching a network. */
const NOWHERE = 'postgres://nobody:nothing@127.0.0.1:1/none';

const dirs: string[] = [];
const opened: Lattice[] = [];

afterEach(() => {
  delete process.env.LATTICE_MANAGED_WORKSPACES_URL;
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An ordinary local workspace, of the shape a migration moves. */
async function localWorkspace(): Promise<{ db: Lattice; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-note-truth-'));
  dirs.push(root);
  mkdirSync(join(root, 'context'), { recursive: true });
  const configPath = join(root, 'lattice.config.yml');
  writeFileSync(configPath, 'db: ./lattice.db\nentities: {}\n', 'utf8');
  const db = new Lattice(
    { config: configPath },
    { encryptionKey: Buffer.alloc(32, 23).toString('base64') },
  );
  registerNativeEntities(db);
  await db.init();
  opened.push(db);
  return { db, configPath };
}

/** The release this note is about: the first version block in the file. */
function currentReleaseSection(): string {
  const heads = [...CHANGELOG.matchAll(/^## \[/gm)];
  expect(heads.length, 'the changelog has version sections').toBeGreaterThan(1);
  return CHANGELOG.slice(heads[0]!.index, heads[1]!.index);
}

describe('a migration is not refused for the session, and the release note must not say it is', () => {
  it('the managed refusal is live in this session — securing is refused by it', async () => {
    const { db } = await localWorkspace();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'https://workspaces.example/managed/tok';

    // The control. Without this the next test proves nothing: a migration that
    // did not refuse could simply be a session that was never managed.
    const refusal = await secureCloud(db).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refusal, 'securing refused in a managed session').toBeDefined();
    expect(cloudErrorCode(refusal)).toBe('cloud_managed');
  });

  it('a migration in that same session runs its checks and reaches the target', async () => {
    const { db, configPath } = await localWorkspace();
    process.env.LATTICE_MANAGED_WORKSPACES_URL = 'https://workspaces.example/managed/tok';

    const failure = await migrateWorkspaceToCloud({
      db,
      configPath,
      url: NOWHERE,
      label: 'note_truth',
      encryptionKey: Buffer.alloc(32, 23).toString('base64'),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    // It got as far as the target it was given. An up-front refusal for the
    // session would have answered before any of that.
    expect(cloudErrorCode(failure), `migration answered: ${(failure as Error)?.message}`).toBe(
      'cloud_unreachable',
    );
    expect(cloudErrorCode(failure), 'and not for the session being a managed one').not.toBe(
      'cloud_managed',
    );
  }, 30_000);

  it('the release note does not describe a migration as refused for that reason', () => {
    // Read per bullet, not per sentence: the claim this replaced never used the
    // word "managed" itself — it said "for the same reason", leaning on the
    // sentence three lines above it. A sentence-level scan cannot see that, and a
    // scan of the whole section flags a migration refused for reasons that are
    // real (a target that is already somebody else's cloud). The bullet is the
    // unit that carries the situation.
    const bullets = currentReleaseSection().split(/\n(?=- \*\*)/);
    expect(bullets.length, 'the section parsed into bullets').toBeGreaterThan(10);

    const claims: string[] = [];
    for (const bullet of bullets) {
      const flat = bullet.replace(/\s+/g, ' ').trim();
      if (!/\bmanag\w*/i.test(flat)) continue;
      for (const sentence of flat.split(/(?<=\.)\s+/)) {
        if (/\bmigrat\w*/i.test(sentence) && /\brefus\w+/i.test(sentence)) claims.push(sentence);
      }
    }

    expect(
      claims,
      'the note tells a reader a migration is refused where a manager owns workspaces, ' +
        'which the product does not do: ' +
        claims.join(' / '),
    ).toEqual([]);
  });
});
