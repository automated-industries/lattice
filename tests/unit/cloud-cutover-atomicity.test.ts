/**
 * The last mile of a migration: all of it, or none of it.
 *
 * Copying rows into a shared database is the visible half of moving a workspace
 * onto one, and it is the half that was already safe — it runs into an empty
 * target, re-counts what it wrote, and throws before anything local is touched.
 * The dangerous half is the four writes AFTER it: store the credential, rewrite
 * the config's `db:` line, flip the workspace registry record, rename the local
 * database file out of the way. Those ran inline in a request handler, in that
 * order, with no unwind between them.
 *
 * A failure anywhere in that sequence used to leave a state nobody can read off
 * the disk: a config naming a credential that was never stored, a registry that
 * disagrees with the config about which database this workspace is, or — the
 * worst one — a config pointing at a local file that has just been renamed out
 * from under it. None of those announce themselves. The next open finds an empty
 * workspace and the operator finds out by losing a day.
 *
 * So each step is forced to fail here, one per test, and each time the workspace
 * has to come back exactly as it was: the config naming its own local file, no
 * credential left behind, the registry record still local, and the rows still
 * readable out of the database that was never moved. Plus the loud, accurate
 * error — "rolled back", naming what happened — because a silent partial is the
 * failure this whole sequence exists to prevent.
 *
 * The failures are forced through the filesystem rather than through a seam in
 * the code, on purpose: a test-only injection point would prove the runner
 * works, not that the real steps unwind. What that costs is one branch this file
 * cannot reach — the case where an UNDO itself fails. Every undo inverts a write
 * that just succeeded against the same file, so making one fail in-process would
 * need the disk to change between two adjacent statements. The branch is real
 * (a machine can lose a volume or a permission mid-sequence) and its contract is
 * that the failure is named in the error rather than swallowed; that contract is
 * readable in the code and is not asserted here. Said out loud rather than left
 * as a coverage gap somebody later mistakes for tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lattice } from '../../src/lattice.js';
import { cutOverWorkspaceToCloud } from '../../src/cloud/migrate.js';
import { cloudErrorCode } from '../../src/cloud/errors.js';
import { readDbLine } from '../../src/framework/db-pointer.js';
import { getDbCredential, saveDbCredential } from '../../src/framework/user-config.js';
import { ensureRootAt, registryPath } from '../../src/framework/lattice-root.js';
import {
  addWorkspace,
  findWorkspaceByConfigPath,
  resolveWorkspacePaths,
  type WorkspaceRecord,
} from '../../src/framework/workspace.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const TARGET_URL = 'postgres://someone:secret@shared.example.test:5432/field_notes';

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `lattice-cutover-${prefix}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  for (const k of ['LATTICE_CONFIG_DIR', 'LATTICE_ROOT', 'LATTICE_ENCRYPTION_KEY']) {
    saved[k] = process.env[k];
  }
  // Credentials, the registry and the master key all resolve inside the scratch
  // tree. Nothing here may reach the machine's own config dir or home root.
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

interface LocalWorkspace {
  root: string;
  record: WorkspaceRecord;
  configPath: string;
  dbPath: string;
  /** The `db:` line as the config carried it before anything ran. */
  originalDbLine: string;
  originalConfig: string;
}

/**
 * A real local workspace with real rows in it — a registry record, a config, and
 * a SQLite file holding data whose survival is the point of every assertion below.
 */
async function localWorkspace(name = 'Field-Notes'): Promise<LocalWorkspace> {
  const root = ensureRootAt(scratch('root'));
  const record = addWorkspace(root, { displayName: name, makeActive: true });
  const paths = resolveWorkspacePaths(root, record);
  writeFileSync(
    paths.configPath,
    [
      `name: "${name}"`,
      'db: ./Data/database.db',
      'entities:',
      '  notes:',
      '    fields:',
      '      id: { type: text, primaryKey: true }',
      '      body: { type: text }',
      '    outputFile: notes.md',
      '',
    ].join('\n'),
    'utf8',
  );
  const db = new Lattice({ config: paths.configPath }, { encryptionKey: KEY });
  await db.init();
  await db.insert('notes', { id: 'n-1', body: 'the row that must survive' });
  db.close();

  const dbPath = join(paths.dataDir, 'database.db');
  expect(existsSync(dbPath), 'the local database file was created').toBe(true);
  return {
    root,
    record,
    configPath: paths.configPath,
    dbPath,
    originalDbLine: readDbLine(paths.configPath) ?? '',
    originalConfig: readFileSync(paths.configPath, 'utf8'),
  };
}

/** Everything a rolled-back workspace must look like: unchanged, and readable. */
async function expectUntouched(ws: LocalWorkspace, label: string): Promise<void> {
  expect(readDbLine(ws.configPath), 'the config still names its own local file').toBe(
    ws.originalDbLine,
  );
  expect(readFileSync(ws.configPath, 'utf8'), 'the config file is byte-for-byte as it was').toBe(
    ws.originalConfig,
  );
  expect(getDbCredential(label), 'no credential was left behind').toBeNull();

  const registered = findWorkspaceByConfigPath(ws.root, ws.configPath);
  expect(registered?.kind, 'the registry still calls this workspace local').toBe('local');
  expect(registered?.db, 'the registry still names the local file').toBe(ws.record.db);

  expect(existsSync(ws.dbPath), 'the local database file is still where it was').toBe(true);
  expect(existsSync(`${ws.dbPath}.local-bak`), 'nothing was archived').toBe(false);

  // The strongest form of "intact": open it again and read the row back.
  const db = new Lattice({ config: ws.configPath }, { encryptionKey: KEY });
  await db.init();
  const rows = await db.query('notes', {});
  db.close();
  expect(
    rows.map((r) => r.id),
    'the data is still readable',
  ).toEqual(['n-1']);
}

describe('cutting a workspace over to a shared database', () => {
  it('moves everything at once when every step lands', async () => {
    const ws = await localWorkspace();
    const before = readFileSync(ws.dbPath);

    const result = cutOverWorkspaceToCloud({
      configPath: ws.configPath,
      label: 'field_notes',
      url: TARGET_URL,
      latticeRoot: ws.root,
      sourceDbPath: ws.dbPath,
    });

    expect(result.dbLine, 'the config now names the stored credential').toBe(
      '${LATTICE_DB:field_notes}',
    );
    expect(readDbLine(ws.configPath)).toBe('${LATTICE_DB:field_notes}');
    expect(getDbCredential('field_notes'), 'and the credential is really behind it').toBe(
      TARGET_URL,
    );

    const registered = findWorkspaceByConfigPath(ws.root, ws.configPath);
    expect(registered?.kind, 'the registry agrees this workspace is shared now').toBe('cloud');
    expect(registered?.db).toBe('${LATTICE_DB:field_notes}');
    expect(registered?.id, 'in place — the same record, not a second one').toBe(ws.record.id);
    expect(result.workspaceId).toBe(ws.record.id);

    // The local file is retired by RENAME, never by deletion: the bytes are
    // still on disk afterwards, which is what makes this recoverable by hand.
    expect(existsSync(ws.dbPath), 'the local file no longer sits where the config pointed').toBe(
      false,
    );
    expect(result.sourceBackupPath).toBe(`${ws.dbPath}.local-bak`);
    expect(readFileSync(result.sourceBackupPath!), 'the archived bytes are the same bytes').toEqual(
      before,
    );
  });

  it('refuses a label a config could never read back, before touching anything', async () => {
    const ws = await localWorkspace();
    // The `${LATTICE_DB:…}` reference is read back with a strict charset, so a
    // key with a space in it resolves to nothing — the failure mode is an empty
    // database with no error at all, which is exactly what must not happen.
    let thrown: unknown;
    try {
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'Field Notes',
        url: TARGET_URL,
        latticeRoot: ws.root,
        sourceDbPath: ws.dbPath,
      });
    } catch (e) {
      thrown = e;
    }
    expect(cloudErrorCode(thrown)).toBe('invalid_request');
    await expectUntouched(ws, 'Field Notes');
  });
});

describe('a failure in the last mile leaves the workspace exactly as it was', () => {
  it('rolls back when the config cannot be rewritten', async () => {
    const ws = await localWorkspace();
    // Forced by making the config a document that cannot take a `db:` key at
    // all: reading it works (so nothing refuses early), and the rewrite is what
    // fails — which is the step being tested.
    const broken = 'not a mapping, just a scalar document\n';
    writeFileSync(ws.configPath, broken, 'utf8');

    let thrown: unknown;
    try {
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'field_notes',
        url: TARGET_URL,
        latticeRoot: ws.root,
        sourceDbPath: ws.dbPath,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown, 'it failed loudly').toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('rolled back');
    expect(readFileSync(ws.configPath, 'utf8'), 'the config was not written to').toBe(broken);
    expect(getDbCredential('field_notes'), 'the credential it had saved is gone again').toBeNull();
    expect(findWorkspaceByConfigPath(ws.root, ws.configPath)?.kind).toBe('local');
    expect(existsSync(ws.dbPath), 'and nothing was archived').toBe(true);
    expect(existsSync(`${ws.dbPath}.local-bak`)).toBe(false);
  });

  it('rolls back the config and the credential when the registry cannot be written', async () => {
    const ws = await localWorkspace();
    // Forced by putting a directory where the registry file lives: the registry
    // is written to a temp file and renamed onto that path, and a rename onto a
    // directory cannot succeed.
    const registry = registryPath(ws.root);
    const contents = readFileSync(registry, 'utf8');
    rmSync(registry);
    mkdirSync(registry);

    let thrown: unknown;
    try {
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'field_notes',
        url: TARGET_URL,
        latticeRoot: ws.root,
        sourceDbPath: ws.dbPath,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown, 'it failed loudly').toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('rolled back');
    expect(
      (thrown as Error).message,
      'and says the copy is already sitting in the target, which is not undone',
    ).toContain('shared.example.test');
    expect(
      (thrown as Error).message,
      'without printing the password that reached it',
    ).not.toContain('secret');

    // Put the registry back so the workspace can be inspected the normal way.
    rmSync(registry, { recursive: true });
    writeFileSync(registry, contents, 'utf8');
    await expectUntouched(ws, 'field_notes');
  });

  it('rolls back everything when the local database cannot be archived', async () => {
    const ws = await localWorkspace();
    // Forced by occupying the archive destination with a non-empty directory:
    // the rename has nowhere to go. This is the step where a missing unwind used
    // to be worst — the config already pointed at the shared database, so the
    // workspace was left naming a store it had not finished moving to.
    const backup = `${ws.dbPath}.local-bak`;
    mkdirSync(backup);
    writeFileSync(join(backup, 'occupied'), 'in the way', 'utf8');

    let thrown: unknown;
    try {
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'field_notes',
        url: TARGET_URL,
        latticeRoot: ws.root,
        sourceDbPath: ws.dbPath,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown, 'it failed loudly').toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('rolled back');
    expect(readDbLine(ws.configPath), 'the config is back on its own local file').toBe(
      ws.originalDbLine,
    );
    expect(getDbCredential('field_notes')).toBeNull();
    const registered = findWorkspaceByConfigPath(ws.root, ws.configPath);
    expect(registered?.kind, 'and the registry is local again').toBe('local');
    expect(registered?.db).toBe(ws.record.db);

    // The local database was never moved, and still reads.
    expect(existsSync(ws.dbPath)).toBe(true);
    const db = new Lattice({ config: ws.configPath }, { encryptionKey: KEY });
    await db.init();
    const rows = await db.query('notes', {});
    db.close();
    expect(rows.map((r) => r.id)).toEqual(['n-1']);
  });

  it('restores a credential the key already held rather than deleting it', async () => {
    // A rollback that deleted the key outright would take out whatever the
    // operator already had under that name — a different workspace's connection
    // — which is a second failure caused by recovering from the first.
    const ws = await localWorkspace();
    const existing = 'postgres://other:pw@elsewhere.example.test:5432/other_db';
    const registry = registryPath(ws.root);
    const contents = readFileSync(registry, 'utf8');

    saveDbCredential('field_notes', existing);

    rmSync(registry);
    mkdirSync(registry);
    expect(() =>
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'field_notes',
        url: TARGET_URL,
        latticeRoot: ws.root,
        sourceDbPath: ws.dbPath,
      }),
    ).toThrow(/rolled back/);
    rmSync(registry, { recursive: true });
    writeFileSync(registry, contents, 'utf8');

    expect(getDbCredential('field_notes'), 'the pre-existing credential is untouched').toBe(
      existing,
    );
  });

  it('leaves a rootless workspace alone too — there is simply no registry step', async () => {
    // A config that belongs to no root is a supported shape (a bare `--config`),
    // and the cutover has to work for it: two steps instead of three, and the
    // same all-or-nothing promise.
    const ws = await localWorkspace();
    const backup = `${ws.dbPath}.local-bak`;
    mkdirSync(backup);
    writeFileSync(join(backup, 'occupied'), 'in the way', 'utf8');

    expect(() =>
      cutOverWorkspaceToCloud({
        configPath: ws.configPath,
        label: 'field_notes',
        url: TARGET_URL,
        latticeRoot: null,
        sourceDbPath: ws.dbPath,
      }),
    ).toThrow(/rolled back/);

    expect(readDbLine(ws.configPath)).toBe(ws.originalDbLine);
    expect(getDbCredential('field_notes')).toBeNull();
    expect(existsSync(ws.dbPath)).toBe(true);
  });
});
